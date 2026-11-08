import type { NextFunction, Request, Response } from 'express';

export function securityHeaders(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  next();
}
