export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (code = 'unauthorized', message = 'Authentication required') =>
  new AppError(401, code, message);
export const forbidden = (code = 'forbidden', message = 'Not allowed') => new AppError(403, code, message);
export const notFound = (code = 'not_found', message = 'Resource not found') => new AppError(404, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooMany = (code: string, message: string) => new AppError(429, code, message);
export const unavailable = (code: string, message: string) => new AppError(503, code, message);
