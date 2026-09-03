import { Router } from 'express';
import { listAlerts, getAlert, updateAlertStatus, addNote } from '../services/alerts.store.js';

const router = Router();

router.get('/', async (_req, res) => {
  const list = await listAlerts();
  res.json(list);
});

router.get('/:id', async (req, res) => {
  const alert = await getAlert(req.params['id']!);
  if (!alert) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(alert);
});

router.put('/:id/status', async (req, res) => {
  const { status, note } = req.body as { status: string; note?: string };
  const updated = await updateAlertStatus(req.params['id']!, status, note);
  if (!updated) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(updated);
});

router.post('/:id/notes', async (req, res) => {
  const { text } = req.body as { text: string };
  const updated = await addNote(req.params['id']!, text);
  if (!updated) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(updated);
});

export default router;
