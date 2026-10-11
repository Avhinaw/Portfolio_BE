import 'dotenv/config';
import { connectDatabase, disconnectDatabase, syncIndexes } from '../src/config/database';
import { loadEnv } from '../src/config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  await connectDatabase(env.MONGODB_URI);
  await syncIndexes();
  console.log('Indexes synchronised (undeclared indexes were dropped).');
  await disconnectDatabase();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
