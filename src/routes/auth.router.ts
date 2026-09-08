import { Router } from 'express';

const router = Router();

const ADMIN_PASSWORD = process.env['FRAUD_ADMIN_PASSWORD'] ?? 'fraud-admin';

router.post('/auth/login', (req, res) => {
  const { password } = req.body as { password?: string };
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  (req.session as Record<string, unknown>)['authenticated'] = true;
  res.json({ ok: true });
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/auth/me', (req, res) => {
  const auth = (req.session as Record<string, unknown>)['authenticated'];
  res.json({ authenticated: !!auth });
});

export default router;
