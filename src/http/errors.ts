import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { logger } from '../logger.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    override readonly message: string,
    readonly code = 'error',
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string) => new AppError(400, m, 'bad_request');
export const unauthorized = (m = 'Not signed in') => new AppError(401, m, 'unauthorized');
export const notFound = (m = 'Not found') => new AppError(404, m, 'not_found');
export const tooMany = (m = 'Too many requests') => new AppError(429, m, 'rate_limited');

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // Postgres check-constraint violations are user error, not server error.
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === '23514') {
    res.status(400).json({
      error: { code: 'validation_failed', message: 'That date is not a valid birthday' },
    });
    return;
  }

  // Multer rejects oversized uploads by throwing; that is a 400, not a 500.
  if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large'
        : `Upload rejected: ${err.message}`;
    res.status(400).json({ code: err.code, error: { code: 'upload_failed', message } });
    return;
  }

  // A malformed JSON body reaches here from express.json().
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
    return;
  }

  logger.error({ err }, 'unhandled request error');
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
}
