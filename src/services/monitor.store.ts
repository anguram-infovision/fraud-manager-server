import { db } from '../db/index.js';
import { monitorRecords } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';

export interface MonitorInput {
  loanId: string;
  borrowerId: string;
  transactionIds: string[];
  riskScore: number;
  signals: { scenario: string }[];
}

/**
 * Persists a sub-threshold AML evaluation as a monitor-tier record (never an alert).
 * Sync re-evaluates every 15s, so records are deduped per loan + fired-scenario set:
 * a repeat updates the existing row (merging transaction IDs) instead of adding one.
 */
export async function recordMonitor(input: MonitorInput): Promise<void> {
  try {
    const scenarioKey = input.signals.map((s) => s.scenario).sort().join(',');
    const timestamp = new Date().toISOString();
    const existing = await db.select().from(monitorRecords)
      .where(and(eq(monitorRecords.loanId, input.loanId), eq(monitorRecords.scenarioKey, scenarioKey)))
      .get();

    if (existing) {
      const txIds = Array.from(new Set([...(JSON.parse(existing.transactionIds) as string[]), ...input.transactionIds]));
      await db.update(monitorRecords).set({
        transactionIds: JSON.stringify(txIds),
        riskScore: input.riskScore,
        signals: JSON.stringify(input.signals),
        updatedAt: timestamp,
      }).where(eq(monitorRecords.id, existing.id));
      return;
    }

    await db.insert(monitorRecords).values({
      id: randomUUID(),
      loanId: input.loanId,
      borrowerId: input.borrowerId,
      engine: 'AML',
      tier: 'MONITOR',
      scenarioKey,
      transactionIds: JSON.stringify(input.transactionIds),
      riskScore: input.riskScore,
      signals: JSON.stringify(input.signals),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch (err) {
    logger.warn(`Failed to record monitor entry for loan ${input.loanId}: ` + (err as Error).message);
  }
}
