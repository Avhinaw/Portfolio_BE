export type SocketRole = 'host' | 'visitor';

/** Stored on socket.data. Always derived from verified credentials, never from client-supplied flags. */
export interface SocketData {
  role: SocketRole;
  /** Host only: session id of the verified access token. */
  sid?: string;
  /** Host only: access-token expiry (unix seconds). */
  exp?: number;
  /** Visitor only: the single meeting this socket is authorized for. */
  roomId?: string;
  /** Host only: meeting rooms this socket joined via host:join-room. */
  joinedRooms: string[];
  /** Rooms in which this socket has reported call:ready (array so it survives remote-socket serialization). */
  readyRooms: string[];
}

export interface AckOk<T = unknown> {
  ok: true;
  data?: T;
}
export interface AckError {
  ok: false;
  error: { code: string; message: string };
}
export type Ack<T = unknown> = (response: AckOk<T> | AckError) => void;
