import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import argon2 from 'argon2';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { io as connectClient, type Socket } from 'socket.io-client';
import type { Express } from 'express';
import type { Server } from 'socket.io';
import { createApp } from '../../src/app';
import { connectDatabase, disconnectDatabase, initIndexes } from '../../src/config/database';
import { loadEnv, type Env } from '../../src/config/env';
import { setIo } from '../../src/services/realtime';
import { stopBackgroundJobs } from '../../src/services/scheduler';
import { createSocketServer } from '../../src/sockets/socket.server';
import { blockTelegram } from './telegram';

export const HOST_EMAIL = 'host@example.com';
export const HOST_PASSWORD = 'correct horse battery staple';
export const ALLOWED_ORIGIN = 'http://localhost:5173';
export const TELEGRAM_TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789abc';

export interface TestServer {
  app: Express;
  env: Env;
  io: Server;
  baseUrl: string;
  stop: () => Promise<void>;
}

/**
 * Boots the real app + Socket.IO against an isolated database. Uses MONGODB_TEST_URI when provided,
 * otherwise an in-memory MongoDB (the binary is downloaded on first use).
 * Never touches production data and never sends real Telegram messages (tests mock fetch).
 */
export async function startTestServer(overrides: Record<string, string> = {}): Promise<TestServer> {
  blockTelegram();
  const memory = process.env.MONGODB_TEST_URI ? null : await MongoMemoryServer.create();
  const uri = process.env.MONGODB_TEST_URI ?? memory!.getUri();
  const dbName = `portfolio_test_${randomBytes(6).toString('hex')}`;

  const hash = await argon2.hash(HOST_PASSWORD, { type: argon2.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1 });
  const env = loadEnv({
    NODE_ENV: 'test',
    MONGODB_URI: uri,
    FRONTEND_ORIGINS: ALLOWED_ORIGIN,
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
    HOST_EMAIL,
    HOST_PASSWORD_HASH: hash,
    TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID: '42',
    HOST_DASHBOARD_URL: 'https://host.example.com',
    MAX_PENDING_PER_VISITOR: '100',
    MAX_PENDING_REQUESTS: '100',
    MEETING_CREATE_RATE_LIMIT_MAX: '1000',
    LOGIN_RATE_LIMIT_MAX: '1000',
    RATE_LIMIT_GLOBAL_PER_MINUTE: '100000',
    HOST_API_RATE_LIMIT_PER_MINUTE: '100000',
    NOTIFY_RETRY_BASE_SECONDS: '1',
    ...overrides,
  });

  await connectDatabase(env.MONGODB_URI, { dbName });
  await initIndexes();

  const app = createApp(env);
  const server = http.createServer(app);
  const io = createSocketServer(server, env);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    app,
    env,
    io,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      stopBackgroundJobs();
      await io.close();
      setIo(null);
      await mongoose.connection.dropDatabase().catch(() => undefined);
      await disconnectDatabase();
      await memory?.stop();
    },
  };
}

export async function loginHost(app: Express): Promise<string> {
  const res = await request(app).post('/api/host/auth/login').send({ email: HOST_EMAIL, password: HOST_PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return res.body.data.accessToken as string;
}

export interface CreatedMeeting {
  id: string;
  roomId: string;
  visitorToken: string;
  status: string;
  expiresAt: string;
}

export async function createMeeting(app: Express, visitorName = 'John', visitorMessage?: string): Promise<CreatedMeeting> {
  const res = await request(app)
    .post('/api/meetings')
    .send({ visitorName, ...(visitorMessage ? { visitorMessage } : {}) });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as CreatedMeeting;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export function connectSocket(baseUrl: string, auth: Record<string, unknown>): Socket {
  return connectClient(baseUrl, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
}

export function waitConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
}

export function waitConnectError(socket: Socket): Promise<Error> {
  return new Promise((resolve, reject) => {
    socket.once('connect_error', (err) => resolve(err));
    socket.once('connect', () => reject(new Error('socket connected unexpectedly')));
  });
}

export function nextEvent<T = unknown>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Resolves true if the event is NOT received within the window. */
export function neverReceives(socket: Socket, event: string, windowMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = () => resolve(false);
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve(true);
    }, windowMs);
  });
}

export interface AckResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export function emitAck(socket: Socket, event: string, payload?: unknown, timeoutMs = 3000): Promise<AckResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ack of ${event}`)), timeoutMs);
    const callback = (res: AckResult) => {
      clearTimeout(timer);
      resolve(res);
    };
    if (payload === undefined) socket.emit(event, callback);
    else socket.emit(event, payload, callback);
  });
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 4000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const VALID_SDP = (type: 'offer' | 'answer') => ({
  type,
  sdp: 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
});

export const VALID_CANDIDATE = {
  candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54400 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
  usernameFragment: 'abcd',
};
