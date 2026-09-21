import { db } from '../db/index.js';
import { systemSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface SystemSettings {
  amlAlertThreshold: number;
  matureLoanPaymentCount: number;
  establishedLoanPaymentCount: number;
  normalPaymentRangeMultiplier: number;
  suppressionsEnabled: boolean;
  /** Re-fires of an already-alerted pattern within this many minutes don't create a new alert. 0 disables. */
  cooldownMinutes: number;
}

export const DEFAULT_SETTINGS: SystemSettings = {
  amlAlertThreshold: 60,
  matureLoanPaymentCount: 6,
  establishedLoanPaymentCount: 3,
  normalPaymentRangeMultiplier: 1.5,
  suppressionsEnabled: true,
  cooldownMinutes: 60,
};

// Short in-process cache — settings are read on every sync tick / webhook call.
const CACHE_TTL_MS = 30_000;
let cached: { value: SystemSettings; expiresAt: number } | null = null;

export async function getSettings(): Promise<SystemSettings> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const row = await db.select().from(systemSettings).where(eq(systemSettings.id, 'default')).get();
  const value: SystemSettings = row
    ? {
        amlAlertThreshold: row.amlAlertThreshold,
        matureLoanPaymentCount: row.matureLoanPaymentCount,
        establishedLoanPaymentCount: row.establishedLoanPaymentCount,
        normalPaymentRangeMultiplier: row.normalPaymentRangeMultiplier,
        suppressionsEnabled: row.suppressionsEnabled,
        cooldownMinutes: row.cooldownMinutes,
      }
    : DEFAULT_SETTINGS;

  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function updateSettings(patch: Partial<SystemSettings>): Promise<SystemSettings> {
  const current = await getSettings();
  const next: SystemSettings = { ...current, ...patch };
  const timestamp = new Date().toISOString();

  await db
    .insert(systemSettings)
    .values({ id: 'default', ...next, updatedAt: timestamp })
    .onConflictDoUpdate({
      target: systemSettings.id,
      set: { ...next, updatedAt: timestamp },
    });

  cached = { value: next, expiresAt: Date.now() + CACHE_TTL_MS };
  return next;
}
