import type { Request, Response } from 'express';
import { optionalUserId } from '../../middlewares/authenticate';
import {
  changeEmailSchema,
  changePasswordSchema,
  confirmEmailChangeSchema,
  forgotPasswordSchema,
  loginMfaSchema,
  loginSchema,
  mfaConfirmSchema,
  mfaEnableSchema,
  mfaSetupSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  updatePhoneSchema,
  verifyEmailSchema,
} from './auth.schema';
import { authService } from './auth.service';
import { contactService } from './contact.service';
import { mfaService } from './mfa.service';

function context(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

export async function register(req: Request, res: Response): Promise<void> {
  const input = registerSchema.parse(req.body);
  const user = await authService.register(input, context(req));
  res.status(201).json(user);
}

export async function login(req: Request, res: Response): Promise<void> {
  const input = loginSchema.parse(req.body);
  const result = await authService.login(input, context(req));
  res.json(result);
}

/** Segundo passo do login (ADR 66): o passe do primeiro e o código; devolve a sessão. */
export async function loginMfa(req: Request, res: Response): Promise<void> {
  const input = loginMfaSchema.parse(req.body);
  res.json(await authService.loginMfa(input, context(req)));
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

/** Rota protegida — troca a senha (RF-017) e devolve o par novo desta sessão; as outras caem. */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const input = changePasswordSchema.parse(req.body);
  res.json(await authService.changePassword(req.user!.uid, input, context(req)));
}

/** Rota protegida — contato da conta (RF-017): e-mail, troca pendente e telefone, só do titular. */
export async function contact(req: Request, res: Response): Promise<void> {
  res.json(await contactService.get(req.user!.uid));
}

/** Rota protegida — pede a troca de e-mail; o link vai ao endereço novo (202: falta confirmar). */
export async function changeEmail(req: Request, res: Response): Promise<void> {
  const input = changeEmailSchema.parse(req.body);
  res.status(202).json(await contactService.requestEmailChange(req.user!.uid, input, context(req)));
}

/** Rota protegida — desiste da troca de e-mail pendente. */
export async function cancelEmailChange(req: Request, res: Response): Promise<void> {
  await contactService.cancelEmailChange(req.user!.uid, context(req));
  res.status(204).send();
}

/**
 * Confirma a troca pelo token do link. Pública (o link pode abrir em outro aparelho); se vier o
 * token de acesso da mesma conta, essa sessão é renovada e as outras caem.
 */
export async function confirmEmailChange(req: Request, res: Response): Promise<void> {
  const { token } = confirmEmailChangeSchema.parse(req.body);
  res.json(await contactService.confirmEmailChange(token, context(req), optionalUserId(req)));
}

// ---------- Verificação em duas etapas da própria conta (RF-090, ADR 66) ----------

/** Rota protegida — a situação da 2FA, se o servidor consegue ativá-la e se o painel a exige. */
export async function mfaStatus(req: Request, res: Response): Promise<void> {
  res.json(await mfaService.status(req.user!.uid, req.user!.role));
}

/** Rota protegida — começa a ativação (senha atual): o segredo novo para o app. */
export async function mfaSetup(req: Request, res: Response): Promise<void> {
  const { password } = mfaSetupSchema.parse(req.body);
  res.json(await mfaService.setup(req.user!.uid, password));
}

/** Rota protegida — ativa com o primeiro código; devolve a sessão nova e os códigos de recuperação. */
export async function mfaEnable(req: Request, res: Response): Promise<void> {
  const { code } = mfaEnableSchema.parse(req.body);
  res.json(await mfaService.enable(req.user!.uid, code, context(req)));
}

/** Rota protegida — desativa (senha + código do app ou de recuperação). */
export async function mfaDisable(req: Request, res: Response): Promise<void> {
  const input = mfaConfirmSchema.parse(req.body);
  await mfaService.disable(req.user!.uid, input, context(req));
  res.status(204).send();
}

/** Rota protegida — troca os códigos de recuperação (senha + código). */
export async function mfaRecoveryCodes(req: Request, res: Response): Promise<void> {
  const input = mfaConfirmSchema.parse(req.body);
  res.json(await mfaService.regenerateRecoveryCodes(req.user!.uid, input, context(req)));
}

/** Rota protegida — grava ou apaga o telefone da conta (E.164). */
export async function updatePhone(req: Request, res: Response): Promise<void> {
  const { phone } = updatePhoneSchema.parse(req.body);
  res.json(await contactService.updatePhone(req.user!.uid, phone, context(req)));
}
