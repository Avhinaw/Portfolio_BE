export {};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by requireHost after the JWT and the server-side session have been verified. */
      hostSession?: { sid: string; exp: number };
    }
  }
}
