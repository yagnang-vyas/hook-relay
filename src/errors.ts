export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'Resource not found') => new AppError(404, 'not_found', message);
export const badRequest = (message: string, code = 'invalid_request') =>
  new AppError(400, code, message);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
