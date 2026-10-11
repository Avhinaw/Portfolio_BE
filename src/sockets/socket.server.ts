import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { Env } from '../config/env';
import { setIo } from '../services/realtime';
import { registerMeetingHandlers } from './meeting.handlers';
import { socketAuth } from './socket.auth';

export function createSocketServer(httpServer: HttpServer, env: Env): Server {
  const io = new Server(httpServer, {
    serveClient: false,
    // Signaling messages are small; SDP is capped at 20 KB by validation.
    maxHttpBufferSize: 64 * 1024,
    connectTimeout: 10_000,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    cors: { origin: env.FRONTEND_ORIGINS, methods: ['GET', 'POST'] },
    // Browsers always send Origin on WebSocket upgrades; reject origins outside the allowlist.
    // Non-browser clients (no Origin) must still pass handshake authentication.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, !origin || env.FRONTEND_ORIGINS.includes(origin));
    },
  });

  io.use((socket, next) => {
    void socketAuth(socket, next);
  });
  io.on('connection', (socket) => registerMeetingHandlers(io, socket));

  setIo(io);
  return io;
}
