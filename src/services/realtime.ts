import type { Server } from 'socket.io';

let io: Server | null = null;

export const setIo = (server: Server | null): void => {
  io = server;
};
export const getIo = (): Server | null => io;

/** Socket.IO room names. */
export const rooms = {
  hosts: 'hosts',
  session: (sid: string) => `session:${sid}`,
  /** Both participants of one meeting. */
  meeting: (roomId: string) => `meeting:${roomId}`,
  meetingHost: (roomId: string) => `meeting:${roomId}:host`,
  meetingVisitor: (roomId: string) => `meeting:${roomId}:visitor`,
};

export function emitToHosts(event: string, payload: unknown): void {
  io?.to(rooms.hosts).emit(event, payload);
}

export function emitToMeeting(roomId: string, event: string, payload: unknown): void {
  io?.to(rooms.meeting(roomId)).emit(event, payload);
}

export function emitToRole(roomId: string, role: 'host' | 'visitor', event: string, payload: unknown): void {
  io?.to(role === 'host' ? rooms.meetingHost(roomId) : rooms.meetingVisitor(roomId)).emit(event, payload);
}

export function disconnectSession(sid: string): void {
  io?.in(rooms.session(sid)).disconnectSockets(true);
}
