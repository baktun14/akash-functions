// Run all pending migrations against the configured database.
// Invoked via `npm run db:migrate`.

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sqlClient } from './client';

async function main() {
  console.log('[migrate] running pending migrations…');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('[migrate] done');
  await sqlClient.end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
