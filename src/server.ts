import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import session from 'express-session';
import { readFileSync, existsSync } from 'fs';
import https from 'https';
import alertsRouter from './routes/alerts.router.js';
import webhookRouter from './routes/webhook.router.js';
import scenariosRouter from './routes/scenarios.router.js';
import authRouter from './routes/auth.router.js';
import { startSyncJob } from './services/sync.service.js';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const API_BASE_PATH = process.env['API_BASE_PATH'] ?? '/fraud/api';
const SESSION_SECRET = process.env['SESSION_SECRET'] ?? 'fraud-manager-dev-secret';
const AUTH_ENABLED = process.env['AUTH_ENABLED'] === 'true';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(morgan('dev'));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 }, // 8h
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Mount on both /api (dev proxy) and /fraud/api (prod IIS) — same pattern as disputes-manager
const PATHS = API_BASE_PATH === '/fraud/api' ? ['/api', '/fraud/api'] : [API_BASE_PATH];

// Auth routes (always public — login/logout/me)
app.use(PATHS, authRouter);

// Session guard — skip when AUTH_ENABLED=false (dev / POC mode)
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_ENABLED) { next(); return; }
  if ((req.session as Record<string, unknown>)['authenticated']) { next(); return; }
  res.status(401).json({ error: 'Unauthenticated' });
}

app.use(PATHS.map(p => `${p}/scenarios`), requireAuth, scenariosRouter);
app.use(PATHS, requireAuth, webhookRouter);
app.use(PATHS, requireAuth, alertsRouter);

const pfxPath = process.env['SSL_PFX_PATH'];
if (pfxPath && existsSync(pfxPath)) {
  const pfx = readFileSync(pfxPath);
  const passphrase = process.env['SSL_PFX_PASSPHRASE'];
  https
    .createServer({ pfx, passphrase }, app)
    .listen(PORT, () => { console.log(`fraud-manager-server (HTTPS) on :${PORT}`); startSyncJob(); });
} else {
  app.listen(PORT, () => {
  console.log(`fraud-manager-server on :${PORT}`);
  startSyncJob();
});
}
