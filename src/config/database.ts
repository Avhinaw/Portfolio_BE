import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { Meeting } from '../models/Meeting';
import { HostSession } from '../models/HostSession';
import { CallSlot } from '../models/CallSlot';
import { HostState } from '../models/HostState';

export async function connectDatabase(uri: string, options: { dbName?: string } = {}): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    ...(options.dbName ? { dbName: options.dbName } : {}),
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
    // Indexes are created explicitly by initIndexes() so startup order is deterministic.
    autoIndex: false,
  });
  logger.info('MongoDB connected');
}

/** Creates all indexes declared on the schemas (idempotent). */
export async function initIndexes(): Promise<void> {
  await Promise.all([
    Meeting.createIndexes(),
    HostSession.createIndexes(),
    CallSlot.createIndexes(),
    HostState.createIndexes(),
  ]);
  logger.info('MongoDB indexes ensured');
}

/** Like initIndexes() but also drops indexes that are no longer declared. Use `npm run db:indexes`. */
export async function syncIndexes(): Promise<void> {
  await Promise.all([
    Meeting.syncIndexes(),
    HostSession.syncIndexes(),
    CallSlot.syncIndexes(),
    HostState.syncIndexes(),
  ]);
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export async function pingDatabase(): Promise<boolean> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return false;
  try {
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
}
