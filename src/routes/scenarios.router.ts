import { Router } from 'express';
import { db } from '../db/index.js';
import { scenarioConfigs } from '../db/schema.js';
import { DEFAULT_CONFIGS } from '../services/aml-engine.service.js';

const router = Router();

router.get('/', async (_req, res) => {
  const rows = await db.select().from(scenarioConfigs).all();
  if (rows.length === 0) {
    res.json(DEFAULT_CONFIGS);
    return;
  }
  const result = Object.fromEntries(
    rows.map((r) => [
      r.scenario,
      { enabled: r.enabled, parameters: JSON.parse(r.parameters) as Record<string, number>, severity: r.severity },
    ])
  );
  res.json(result);
});

router.put('/:scenario', async (req, res) => {
  const scenario = req.params['scenario']!;
  const { enabled, parameters, severity } = req.body as {
    enabled: boolean;
    parameters: Record<string, number>;
    severity: string;
  };
  const timestamp = new Date().toISOString();
  await db
    .insert(scenarioConfigs)
    .values({ scenario, enabled, parameters: JSON.stringify(parameters), severity, updatedAt: timestamp })
    .onConflictDoUpdate({
      target: scenarioConfigs.scenario,
      set: { enabled, parameters: JSON.stringify(parameters), severity, updatedAt: timestamp },
    });
  res.json({ scenario, enabled, parameters, severity });
});

export default router;
