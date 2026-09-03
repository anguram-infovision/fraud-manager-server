// Central SQL Server connection pool — same pattern as disputes-manager/server/src/services/db.service.ts
// Reads SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD from .env
import sql from 'mssql';
import 'dotenv/config';
import logger from '../utils/logger.js';

const config: sql.config = {
  server: process.env['SQL_SERVER']!,
  database: process.env['SQL_DATABASE']!,
  user: process.env['SQL_USER']!,
  password: process.env['SQL_PASSWORD']!,
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30_000,
  },
};

const pool = new sql.ConnectionPool(config);
let connectPromise: Promise<sql.ConnectionPool> | null = null;

export const getPool = (): Promise<sql.ConnectionPool> => {
  if (!connectPromise) {
    connectPromise = pool.connect().then((p) => {
      logger.info(`SQL Server connected: ${process.env['SQL_SERVER']} / ${process.env['SQL_DATABASE']}`);
      return p;
    });
  }
  return connectPromise;
};

export { sql };
