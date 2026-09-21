import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['DB_PATH'] = join(tmpdir(), `fraud-demo-test-${process.pid}.db`);
const { db } = await import('../db/index.js');
const { alerts, monitorRecords } = await import('../db/schema.js');
const { migrate } = await import('drizzle-orm/libsql/migrator');
const { SCENARIOS, runScenario, resetDemoData } = await import('./demo-scenarios.js');
const { DEFAULT_SETTINGS } = await import('./settings.service.js');
const { DEFAULT_CONFIGS } = await import('./aml-engine.service.js');

await migrate(db, { migrationsFolder: './drizzle' });

test('all 12 demo scenarios produce the documented engine outcome', async () => {
  assert.equal(SCENARIOS.length, 12);
  for (const s of SCENARIOS) {
    await resetDemoData([s.build(Date.now()).loanId]);
    const r = await runScenario(s, DEFAULT_SETTINGS, DEFAULT_CONFIGS);
    assert.ok(r.match, `#${r.n} ${r.name}: expected ${r.expected}, got ${r.actual} (fired [${r.fired}] suppressed [${r.suppressed}])`);
  }
});

test('scenario 7 is flagged demo-only in its result', async () => {
  const s7 = SCENARIOS.find((s) => s.n === 7)!;
  await resetDemoData([s7.build(Date.now()).loanId]);
  const r = await runScenario(s7, DEFAULT_SETTINGS, DEFAULT_CONFIGS);
  assert.match(r.demoOnly ?? '', /DEMO-ONLY/);
});

test('alerts carry narratives; cooldown scenario leaves exactly one alert with one recurrence', async () => {
  const rows = await db.select().from(alerts).all();
  assert.ok(rows.length >= 3); // #5, #6, #7 (+ #11)
  assert.ok(rows.every((r) => r.narrative && r.narrative.length > 0));
  const s11 = rows.filter((r) => r.loanId === 'DEMO-S11-COOLDOWN');
  assert.equal(s11.length, 1);
  assert.equal(s11[0]!.recurrenceCount, 1);
});

test('monitor-tier scenarios (3, 9, 10, 12) never create alerts; reset removes everything', async () => {
  const monitored = (await db.select().from(monitorRecords).all()).map((r) => r.loanId).sort();
  assert.deepEqual(monitored, ['DEMO-S03-PAYOFF-NEW', 'DEMO-S09-CARD-ROTATION', 'DEMO-S10-DEVIATION-PLUS-SOURCES', 'DEMO-S12-REFUND-DISPUTE']);
  const alertLoans = (await db.select().from(alerts).all()).map((r) => r.loanId);
  for (const l of monitored) assert.ok(!alertLoans.includes(l), l);

  await resetDemoData();
  assert.equal((await db.select().from(alerts).all()).length, 0);
  assert.equal((await db.select().from(monitorRecords).all()).length, 0);
});
