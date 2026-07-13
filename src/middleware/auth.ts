import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

export function requireDemoToken(request: Request, response: Response, next: NextFunction): void {
  const authorization = request.header('authorization');

  if (!authorization || authorization !== `Bearer ${config.demoToken}`) {
    response.status(401).json({ error: { message: 'Missing or invalid demo token', code: 'unauthorized' } });
    return;
  }

  next();
}
