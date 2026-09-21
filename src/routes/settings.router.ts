import { Router } from 'express';
import { getSettings, updateSettings, type SystemSettings } from '../services/settings.service.js';
import { db } from '../db/index.js';
import { suppressionLog, monitorRecords } from '../db/schema.js';
import { desc } from 'drizzle-orm';

const router = Router();

router.get('/settings', async (_req, res) => {
  res.json(await getSettings());
});

router.put('/settings', async (req, res) => {
  const patch = req.body as Partial<SystemSettings>;
  res.json(await updateSettings(patch));
});

// Recent suppressed (detected-but-not-alerted) signals — transparency for tuning.
router.get('/settings/suppressions', async (_req, res) => {
  const rows = await db.select().from(suppressionLog).orderBy(desc(suppressionLog.createdAt)).limit(100).all();
  res.json(rows);
});

// Monitor-tier AML records (score below the alert threshold) — visible, but no action required.
router.get('/settings/monitor', async (_req, res) => {
  const rows = await db.select().from(monitorRecords).orderBy(desc(monitorRecords.updatedAt)).limit(100).all();
  res.json(rows.map((r) => ({ ...r, transactionIds: JSON.parse(r.transactionIds) as string[], signals: JSON.parse(r.signals) as unknown[] })));
});

export default router;
