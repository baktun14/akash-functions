// Hono error handler — converts thrown errors to JSON { error: { code, message } }.

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ConsoleApiError } from '../akash/console-client';
import { log } from '../lib/log';

export function errorHandler(err: Error, c: Context) {
  if (err instanceof HTTPException) {
    return c.json(
      { error: { code: `HTTP_${err.status}`, message: err.message } },
      err.status
    );
  }
  if (err instanceof ConsoleApiError) {
    log.warn('console api error', { code: err.code, message: err.message });
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400 | 401 | 403 | 404 | 500);
  }
  log.error('unhandled error', { err: String(err), stack: err.stack });
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    500
  );
}
