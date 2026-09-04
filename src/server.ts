import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { readFileSync, existsSync } from 'fs';
import https from 'https';
import alertsRouter from './routes/alerts.router.js';
import webhookRouter from './routes/webhook.router.js';
import scenariosRouter from './routes/scenarios.router.js';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const API_BASE_PATH = process.env['API_BASE_PATH'] ?? '/fraud/api';

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

// Mount on both /api (dev proxy) and /fraud/api (prod IIS) — same pattern as disputes-manager
const PATHS = API_BASE_PATH === '/fraud/api' ? ['/api', '/fraud/api'] : [API_BASE_PATH];
app.use(PATHS.map(p => `${p}/scenarios`), scenariosRouter);
app.use(PATHS, webhookRouter);
app.use(PATHS, alertsRouter);

const pfxPath = process.env['SSL_PFX_PATH'];
if (pfxPath && existsSync(pfxPath)) {
  const pfx = readFileSync(pfxPath);
  const passphrase = process.env['SSL_PFX_PASSPHRASE'];
  https
    .createServer({ pfx, passphrase }, app)
    .listen(PORT, () => console.log(`fraud-manager-server (HTTPS) on :${PORT}`));
} else {
  app.listen(PORT, () => console.log(`fraud-manager-server on :${PORT}`));
}
