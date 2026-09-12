import { PrismaClient } from '../generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { pgPool } from './db-pool';

const globalForPrisma = global as unknown as {
  prisma?: PrismaClient;
};

// The pg.Pool is owned by ./db-pool (one pool per process, shared with the
// Drizzle client from Phase 3 — DAT-09/D-06); Prisma only wraps it.
const adapter = new PrismaPg(pgPool);

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}