import 'dotenv/config';
import http from 'node:http';
import { connectDatabase, disconnectDatabase, initIndexes } from './config/database';
import { loadEnv } from './config/env';
import { createApp } from './app';
import { setIo } from './services/realtime';
import { startBackgroundJobs, stopBackgroundJobs } from './services/scheduler';
import { createSocketServer } from './sockets/socket.server';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  const env = loadEnv(); // fails fast with a readable message (never printing secret values)

  await connectDatabase(env.MONGODB_URI);
  await initIndexes();

  const app = createApp(env);
  const server = http.createServer(app);
  const io = createSocketServer(server, env);
  startBackgroundJobs();

  server.listen(env.PORT, env.HOST, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'portfolio-call-backend listening');
    if (!env.TELEGRAM_BOT_TOKEN) logger.warn('Telegram is not configured: incoming-call alerts are disabled');
    if (env.TURN_URL.length === 0) {
      logger.warn('No TURN server configured: calls may fail for visitors behind symmetric NAT / strict firewalls');
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 15_000);
    force.unref();

    try {
      stopBackgroundJobs();
      await io.close(); // also closes the underlying HTTP server and all sockets
      setIo(null);
      await disconnectDatabase();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
