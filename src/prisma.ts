import { PrismaPg } from '@prisma/adapter-pg';
import type pg from 'pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaClient };
export type Db = PrismaClient;

/** Prisma shares the application's pg pool so raw queries and the ORM see the same connections. */
export function createPrisma(pool: pg.Pool, schema?: string): PrismaClient {
  const adapter = new PrismaPg(pool, schema !== undefined ? { schema } : undefined);
  return new PrismaClient({ adapter });
}
