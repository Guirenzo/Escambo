import type { Request, Response } from 'express';
import { loginSchema, refreshSchema, registerSchema } from './auth.schema';
import { authService } from './auth.service';

function context(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

export async function register(req: Request, res: Response): Promise<void> {
  const input = registerSchema.parse(req.body);
  const user = await authService.register(input);
  res.status(201).json(user);
}

export async function login(req: Request, res: Response): Promise<void> {
  const input = loginSchema.parse(req.body);
  const result = await authService.login(input, context(req));
  res.json(result);
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = refreshSchema.parse(req.body);
  const tokens = await authService.refresh(refreshToken, context(req));
  res.json(tokens);
}

export async function logout(req: Request, res: Response): Promise<void> {
  const { refreshToken } = refreshSchema.parse(req.body);
  await authService.logout(refreshToken);
  res.status(204).send();
}

/** Rota protegida — encerra todas as sessões do usuário do token. */
export async function logoutAll(req: Request, res: Response): Promise<void> {
  const revoked = await authService.logoutAll(req.user!.sub);
  res.json({ revoked });
}

/** Rota protegida — dados do usuário do token. */
export async function me(req: Request, res: Response): Promise<void> {
  const user = await authService.getByUlid(req.user!.sub);
  res.json(user);
}
