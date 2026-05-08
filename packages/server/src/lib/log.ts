// Tiny structured logger. Level is implicit — INFO/WARN/ERROR via method choice.

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};

function emit(level: string, msg: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}
