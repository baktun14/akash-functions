#!/usr/bin/env node
import { runCli } from './commands.js';

runCli(process.argv.slice(2)).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`akash-functions: ${message}`);
  process.exitCode = 1;
});
