import type { Request, Response } from 'express';
import {
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.schema';
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

/** Confirma o e-mail pelo token do link. */
export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const { token } = verifyEmailSchema.parse(req.body);
  res.json(await authService.verifyEmail(token));
}

/** Rota protegida — reenvia o link de confirmação. */
export async function resendVerification(req: Request, res: Response): Promise<void> {
  await authService.resendVerification(req.user!.uid);
  res.status(202).json({ sent: true });
}

/** Esqueci minha senha: resposta idêntica exista ou não a conta. */
export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { email } = forgotPasswordSchema.parse(req.body);
  await authService.forgotPassword(email);
  res.status(202).json({ sent: true });
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { token, password } = resetPasswordSchema.parse(req.body);
  await authService.resetPassword(token, password);
  res.status(204).send();
}
