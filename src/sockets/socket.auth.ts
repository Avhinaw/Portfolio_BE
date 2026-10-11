import type { Socket } from 'socket.io';
import { authenticateVisitor } from '../services/meeting.service';
import { verifyAccessToken } from '../services/auth.service';
import type { SocketData } from '../types/socket';
import { handshakeSchema } from '../validators/signaling.validator';

function reject(next: (err?: Error) => void, code: string): void {
  const err = new Error(code) as Error & { data?: { code: string } };
  err.data = { code };
  next(err);
}

/**
 * Handshake authentication. Host sockets present the same access token as the REST API (and the
 * server-side session must still be valid). Visitor sockets present roomId + the meeting-specific
 * visitor token. The `role` field only selects which credential to verify; it grants nothing by itself.
 */
export async function socketAuth(socket: Socket, next: (err?: Error) => void): Promise<void> {
  const parsed = handshakeSchema.safeParse(socket.handshake.auth);
  if (!parsed.success) return reject(next, 'unauthorized');

  try {
    if (parsed.data.role === 'host') {
      const host = await verifyAccessToken(parsed.data.token);
      const data: SocketData = { role: 'host', sid: host.sid, exp: host.exp, joinedRooms: [], readyRooms: [] };
      socket.data = data;
    } else {
      await authenticateVisitor(parsed.data.roomId, parsed.data.visitorToken);
      const data: SocketData = { role: 'visitor', roomId: parsed.data.roomId, joinedRooms: [], readyRooms: [] };
      socket.data = data;
    }
    return next();
  } catch {
    return reject(next, 'unauthorized');
  }
}
