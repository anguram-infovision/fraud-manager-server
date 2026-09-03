import winston from 'winston';
import 'winston-daily-rotate-file';

const { combine, timestamp, printf, colorize, json } = winston.format;

const devFormat = combine(
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    let log = `[${ts}] ${level}: ${message}`;
    if (Object.keys(meta).length > 0) log += ` ${JSON.stringify(meta)}`;
    return log;
  })
);

const prodFormat = combine(timestamp(), json());

const transports: winston.transport[] = [new winston.transports.Console()];

if (process.env['NODE_ENV'] === 'production') {
  transports.push(
    new winston.transports.DailyRotateFile({
      dirname: 'logs',
      filename: 'fraud-api-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true,
    })
  );
}

const logger = winston.createLogger({
  level: process.env['NODE_ENV'] === 'production' ? 'info' : 'debug',
  format: process.env['NODE_ENV'] === 'production' ? prodFormat : devFormat,
  transports,
});

export default logger;
