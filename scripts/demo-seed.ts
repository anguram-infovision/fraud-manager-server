/**
 * Demo seed: runs 12 engineered scenarios through the REAL fraud/AML engines and alert store.
 * Nothing here writes to AFS or Braintree — the input (borrower history + transaction) is synthetic,
 * the decisions are not.
 *
 * Usage (in server/):
 *   npx tsx scripts/demo-seed.ts --all                 dry run against a throwaway DB, prints the summary table
 *   npx tsx scripts/demo-seed.ts --scenario 5          one scenario
 *   npx tsx scripts/demo-seed.ts --all --persist       write into data/fraud.db so alerts appear in the UI
 *   npx tsx scripts/demo-seed.ts --reset               remove all DEMO-* rows from data/fraud.db
 *
 * Exit code 1 if any scenario's actual outcome differs from its expectation — run --all before a demo.
 */
import 'dotenv/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const persist = args.includes('--persist');
const reset = args.includes('--reset');
const all = args.includes('--all');
const scenarioIdx = args.indexOf('--scenario');
const only = scenarioIdx >= 0 ? Number(args[scenarioIdx + 1]) : undefined;

if (!all && !reset && only === undefined) {
  console.error('Specify --all, --scenario N, or --reset (add --persist to write to data/fraud.db).');
  process.exit(2);
}

// Dry runs use a throwaway DB (overrides DB_PATH from .env); --persist/--reset use the real one.
if (!persist && !reset) process.env['DB_PATH'] = join(tmpdir(), `fraud-demo-${process.pid}.db`);

const { db } = await import('../src/db/index.js');
const { migrate } = await import('drizzle-orm/libsql/migrator');
const { SCENARIOS, runScenario, resetDemoData } = await import('../src/services/demo-scenarios.js');
const { getSettings } = await import('../src/services/settings.service.js');
const { getScenarioConfigs } = await import('../src/services/aml-engine.service.js');

if (!persist && !reset) await migrate(db, { migrationsFolder: './drizzle' });

if (reset) {
  await resetDemoData();
  console.log('Removed all DEMO-* alerts, monitor records and suppression-log rows.');
  process.exit(0);
}

const selected = only !== undefined ? SCENARIOS.filter((s) => s.n === only) : SCENARIOS;
if (selected.length === 0) { console.error(`No scenario ${only}. Valid: 1-${SCENARIOS.length}.`); process.exit(2); }

// Each scenario starts clean so the script is repeatable (only its own loans are touched).
const [settings, configs] = await Promise.all([getSettings(), getScenarioConfigs()]);
const results = [];
for (const s of selected) {
  await resetDemoData([s.build(Date.now()).loanId]);
  results.push(await runScenario(s, settings, configs));
}

const pad = (v: string, w: number) => v.padEnd(w);
console.log(`\n${persist ? 'Persisted to data/fraud.db' : 'Dry run (throwaway DB)'} — settings: gate ${settings.amlAlertThreshold}, cooldown ${settings.cooldownMinutes}m, suppression ${settings.suppressionsEnabled ? 'on' : 'OFF'}\n`);
console.log(`${pad('#', 3)} ${pad('Scenario', 68)} ${pad('Expected', 11)} ${pad('Actual', 11)} Match`);
console.log('-'.repeat(101));
for (const r of results) {
  console.log(`${pad(String(r.n), 3)} ${pad(r.name, 68)} ${pad(r.expected, 11)} ${pad(r.actual, 11)} ${r.match ? 'ok' : 'MISMATCH'}`);
  if (r.demoOnly) console.log(`      !! ${r.demoOnly}`);
  if (!r.match) console.log(`      fired: [${r.fired.join(', ')}]  suppressed: [${r.suppressed.join(', ')}]`);
}

const notes = results.filter((r) => r.note);
if (notes.length) {
  console.log('\nNotes:');
  for (const r of notes) console.log(`  #${r.n}: ${r.note}`);
}
const narratives = results.filter((r) => r.narrative);
if (narratives.length) {
  console.log('\nGenerated summaries:');
  for (const r of narratives) console.log(`  #${r.n}: ${r.narrative}`);
}

const bad = results.filter((r) => !r.match).length;
console.log(`\n${results.length - bad}/${results.length} scenarios matched expectations.`);
process.exit(bad ? 1 : 0);
