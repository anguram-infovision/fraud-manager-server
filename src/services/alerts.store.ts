import { db } from '../db/index.js';
import { alerts, alertNotes, auditLog } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';

export interface CreateAlertInput {
  type: string;
  severity: string;
  borrowerId: string;
  loanId: string;
  transactionIds: string[];
  riskScore: number;
  signals: unknown[];
  braintreeSignals: unknown;
}

function now() {
  return new Date().toISOString();
}

/**
 * Creates a new alert or merges into an existing OPEN alert for the same loanId+type.
 * Prevents duplicate rows when multiple settlements on the same loan all trigger the same rule.
 */
export async function upsertAlert(input: CreateAlertInput) {
  const existing = await db.select().from(alerts)
    .where(and(eq(alerts.loanId, input.loanId), eq(alerts.type, input.type), eq(alerts.status, 'OPEN')))
    .get();

  if (existing) {
    const timestamp = now();
    const mergedTxIds = Array.from(new Set([
      ...(JSON.parse(existing.transactionIds) as string[]),
      ...input.transactionIds,
    ]));
    const existingSignals = JSON.parse(existing.signals) as { rule: string; description: string; value: unknown }[];
    const incomingSignals = input.signals as { rule: string; description: string; value: unknown }[];
    const seenRules = new Set(existingSignals.map(s => s.rule));
    const mergedSignals = [
      ...existingSignals,
      ...incomingSignals.filter(s => !seenRules.has(s.rule)),
    ];
    const scoreMultiplier = existing.type === 'FRAUD' ? 30 : 25;
    const newScore = Math.min(100, mergedSignals.length * scoreMultiplier);
    await db.update(alerts).set({
      transactionIds: JSON.stringify(mergedTxIds),
      signals: JSON.stringify(mergedSignals),
      riskScore: newScore,
      severity: newScore >= 75 ? 'CRITICAL' : newScore >= 50 ? 'HIGH' : newScore >= 25 ? 'MEDIUM' : 'LOW',
      updatedAt: timestamp,
    }).where(eq(alerts.id, existing.id));
    return getAlert(existing.id);
  }

  return createAlert(input);
}

export async function createAlert(input: CreateAlertInput) {
  const id = randomUUID();
  const timestamp = now();
  await db.insert(alerts).values({
    id,
    type: input.type,
    severity: input.severity,
    status: 'OPEN',
    borrowerId: input.borrowerId,
    loanId: input.loanId,
    transactionIds: JSON.stringify(input.transactionIds),
    riskScore: input.riskScore,
    signals: JSON.stringify(input.signals),
    braintreeSignals: JSON.stringify(input.braintreeSignals),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return getAlert(id);
}

export async function getAlert(id: string) {
  const row = await db.select().from(alerts).where(eq(alerts.id, id)).get();
  if (!row) return null;
  const notes = await db.select().from(alertNotes).where(eq(alertNotes.alertId, id)).all();
  return mapAlert(row, notes);
}

export async function listAlerts() {
  const rows = await db.select().from(alerts).all();
  return Promise.all(
    rows.map(async (row) => {
      const notes = await db.select().from(alertNotes).where(eq(alertNotes.alertId, row.id)).all();
      return mapAlert(row, notes);
    })
  );
}

export async function updateAlertStatus(id: string, status: string, note?: string) {
  const existing = await getAlert(id);
  if (!existing) return null;
  const timestamp = now();
  await db.update(alerts).set({ status, updatedAt: timestamp }).where(eq(alerts.id, id));
  await db.insert(auditLog).values({
    id: randomUUID(),
    alertId: id,
    action: 'STATUS_UPDATE',
    previousValue: existing.status,
    newValue: status,
    createdAt: timestamp,
  });
  if (note) await addNote(id, note);
  return getAlert(id);
}

export async function addNote(alertId: string, text: string) {
  await db.insert(alertNotes).values({ id: randomUUID(), alertId, text, createdAt: now() });
  return getAlert(alertId);
}

function mapAlert(
  row: typeof alerts.$inferSelect,
  notes: (typeof alertNotes.$inferSelect)[]
) {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    status: row.status,
    borrowerId: row.borrowerId,
    loanId: row.loanId,
    transactionIds: JSON.parse(row.transactionIds) as string[],
    riskScore: row.riskScore,
    signals: JSON.parse(row.signals) as unknown[],
    braintreeSignals: JSON.parse(row.braintreeSignals) as unknown,
    notes: notes.map((n) => ({ id: n.id, alertId: n.alertId, text: n.text, createdAt: n.createdAt })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
