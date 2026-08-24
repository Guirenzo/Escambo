import type { Request, Response } from 'express';
import { loginSchema, registerSchema } from './auth.schema';
import { authService } from './auth.service';

export async function register(req: Request, res: Response): Promise<void> {
  const input = registerSchema.parse(req.body);
  const user = await authService.register(input);
  res.status(201).json(user);
}

export async function login(req: Request, res: Response): Promise<void> {
  const input = loginSchema.parse(req.body);
  const result = await authService.login(input);
  res.json(result);
}

/** Rota protegida — req.user é preenchido pelo middleware authenticate. */
export async function me(req: Request, res: Response): Promise<void> {
  const user = await authService.getByUlid(req.user!.sub);
  res.json(user);
}
