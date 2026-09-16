import { db } from '../db/index.js';
import { suppressionLog } from '../db/schema.js';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';

export interface SuppressionEntry {
  scenario: string;
  reason: string;
  value: string | number;
}

/** Persists suppressed (detected-but-not-alerted) signals for audit/tuning visibility. */
export async function logSuppressions(loanId: string, entries: SuppressionEntry[], engine: 'FRAUD' | 'AML'): Promise<void> {
  if (entries.length === 0) return;
  const timestamp = new Date().toISOString();
  try {
    await db.insert(suppressionLog).values(
      entries.map((e) => ({
        id: randomUUID(),
        loanId,
        engine,
        scenario: e.scenario,
        reason: e.reason,
        value: String(e.value),
        createdAt: timestamp,
      }))
    );
  } catch (err) {
    logger.warn(`Failed to log suppressions for loan ${loanId}: ` + (err as Error).message);
  }
}
