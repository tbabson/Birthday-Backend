import pino from 'pino';
import { env } from './config/env.js';

/**
 * This is a database of other people's personal data (§6.7). Names, emails,
 * notes and photo URLs never reach the log stream.
 */
const REDACTED = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.email',
  '*.name',
  '*.notes',
  '*.photoUrl',
  '*.password',
  '*.token',
  'contact.name',
  'contact.notes',
  'user.email',
];

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  redact: { paths: REDACTED, censor: '[redacted]' },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino/file', options: { destination: 1 } } }
    : {}),
});

export type Logger = typeof logger;
