// Akash Functions backend — Hono on Node, Drizzle on Postgres, talks to
// console-api.akash.network on the user's behalf.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { startReconciler, stopReconciler } from './akash/reconciler';
import { env } from './env';
import { errorHandler } from './middleware/error';
import { akashMetaRouter } from './routes/akash-meta';
import { agentRouter } from './routes/agent';
import { deployRouter } from './routes/deploy';
import { functionsRouter } from './routes/functions';
import { keysRouter } from './routes/keys';
import { runnerRouter } from './routes/runner';
import { usageRouter } from './routes/usage';
import { log } from './lib/log';

const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-Api-Key'],
    credentials: false,
  })
);

app.get('/api/health', (c) => c.json({ ok: true, runner: env.RUNNER_IMAGE }));
app.route('/api/functions', functionsRouter);
app.route('/api/functions', deployRouter);
app.route('/api/keys', keysRouter);
app.route('/api/runner', runnerRouter);
app.route('/api/usage', usageRouter);
app.route('/api/agent', agentRouter);
app.route('/api', akashMetaRouter);

app.onError(errorHandler);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info(`server listening on http://localhost:${info.port}`, { runner: env.RUNNER_IMAGE });
  startReconciler();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`port :${env.PORT} already in use — run \`npm run dev:stop\` and retry`, {
      code: err.code,
    });
  } else {
    log.error('server error', { err: String(err), code: err.code });
  }
  process.exit(1);
});

let isShuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info(`received ${signal}, shutting down`);
  stopReconciler();
  const force = setTimeout(() => {
    log.warn('shutdown timed out, forcing exit');
    process.exit(0);
  }, 3000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
