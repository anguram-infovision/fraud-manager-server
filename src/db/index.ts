import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import 'dotenv/config';

const dbPath = process.env['DB_PATH'] ?? './data/fraud.db';
mkdirSync(dirname(resolve(dbPath)), { recursive: true });

const client = createClient({ url: `file:${resolve(dbPath)}` });

export const db = drizzle(client, { schema });
export type Db = typeof db;
