import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env';
import * as schema from './schema';

export const sqlClient = postgres(env.DATABASE_URL, { max: 10 });
export const db = drizzle(sqlClient, { schema });
export type Db = typeof db;
