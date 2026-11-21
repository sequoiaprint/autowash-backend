import type { Response } from 'express';

export interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

export function fail(res: Response, status: number, code: string, message: string): void {
  const body: ErrorBody = { success: false, error: { code, message } };
  res.status(status).json(body);
}
