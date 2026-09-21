import { db } from '../db/index.js';
import { alerts, alertNotes, auditLog } from '../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { DEFAULT_SETTINGS } from './settings.service.js';
import logger from '../utils/logger.js';

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

const ACTIVE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'ESCALATED'];

/** Fraud signals are keyed by `rule`, AML signals by `scenario`. */
function signalKey(s: unknown): string {
  const x = s as { rule?: string; scenario?: string };
  return x.rule ?? x.scenario ?? '';
}

/**
 * Creates a new alert, or folds the evaluation into an existing one:
 *  1. Cooldown — if an active (OPEN/UNDER_REVIEW/ESCALATED) alert for the same loanId+type already
 *     covers every incoming signal and was last seen within `cooldownMinutes`, no new alert is
 *     created; its recurrenceCount/lastSeenAt are bumped instead. Because lastSeenAt slides on each
 *     re-fire, a pattern that keeps firing stays quiet until it has been absent for a full window.
 *  2. Otherwise, merges into an existing OPEN alert for the same loanId+type (new signals only).
 *  3. Otherwise creates a new alert.
 */
export async function upsertAlert(input: CreateAlertInput, cooldownMinutes = DEFAULT_SETTINGS.cooldownMinutes) {
  const active = await db.select().from(alerts)
    .where(and(eq(alerts.loanId, input.loanId), eq(alerts.type, input.type), inArray(alerts.status, ACTIVE_STATUSES)))
    .all();

  const incomingKeys = input.signals.map(signalKey);
  const cutoff = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();
  const covering = cooldownMinutes > 0
    ? active.find((a) => {
        if ((a.lastSeenAt ?? a.createdAt) < cutoff) return false;
        const have = new Set((JSON.parse(a.signals) as unknown[]).map(signalKey));
        return incomingKeys.every((k) => have.has(k));
      })
    : undefined;

  if (covering) {
    const timestamp = now();
    await db.update(alerts).set({
      transactionIds: JSON.stringify(Array.from(new Set([...(JSON.parse(covering.transactionIds) as string[]), ...input.transactionIds]))),
      recurrenceCount: covering.recurrenceCount + 1,
      lastSeenAt: timestamp,
    }).where(eq(alerts.id, covering.id));
    logger.info(`Alert cooldown: loan=${input.loanId} type=${input.type} already covered by alert ${covering.id} (recurrence ${covering.recurrenceCount + 1})`);
    return getAlert(covering.id);
  }

  const existing = active.find((a) => a.status === 'OPEN');

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
      lastSeenAt: timestamp,
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
    lastSeenAt: timestamp,
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
    recurrenceCount: row.recurrenceCount,
    lastSeenAt: row.lastSeenAt ?? row.createdAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
