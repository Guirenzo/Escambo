import { z } from 'zod';
import { BRAZIL_TIMEZONES } from '../../utils/timezone';
import { normalizeBrazilPhone } from './phone';

/** Validação de entrada (RNF-015: schema em 100% das rotas). */

/** Regra de força da senha: a mesma no cadastro, na redefinição e na troca com login (RF-017). */
export const passwordSchema = z.string().min(8, 'A senha deve ter ao menos 8 caracteres');

export const registerSchema = z.object({
  email: z.string().email('E-mail inválido'),
  password: passwordSchema,
  role: z.enum(['client', 'freelancer', 'company']).default('client'),
  /** Fuso detectado no aparelho (ADR 51); só os do Brasil. */
  timezone: z.enum(BRAZIL_TIMEZONES).optional(),
  /**
   * O gesto de aceitar os Termos e a Política, no cadastro (RN-071, ADR 54): é o que a API grava
   * como consentimento, na versão vigente. Sem ele, não há conta.
   */
  legalAccepted: z.literal(true, {
    errorMap: () => ({ message: 'É preciso aceitar os Termos de Uso e a Política de Privacidade' }),
  }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email('E-mail inválido'),
  password: z.string().min(1, 'Senha obrigatória'),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Segundo fator (ADR 66): 6 dígitos do app autenticador ou um código de recuperação (XXXX-XXXX).
 * A forma é conferida no service, que conta o erro na trava (código com cara errada também conta).
 */
const mfaCodeSchema = z
  .string()
  .trim()
  .min(1, 'Informe o código')
  .max(32, 'Código inválido: use os 6 dígitos do app ou um código de recuperação');

/** POST /auth/login/mfa: o passe do login com senha e o código. */
export const loginMfaSchema = z.object({
  mfaToken: z.string().min(1, 'Token obrigatório').max(2048, 'Token inválido'),
  code: mfaCodeSchema,
});
export type LoginMfaInput = z.infer<typeof loginMfaSchema>;
/** Começar a ativação pede a senha atual: quem está com a conta aberta não liga a 2FA dos outros. */
export const mfaSetupSchema = z.object({
  password: z.string().min(1, 'Informe a senha atual'),
});
export const mfaEnableSchema = z.object({ code: mfaCodeSchema });
/** Desativar e trocar os códigos de recuperação: a senha e um código (do app ou de recuperação). */
export const mfaConfirmSchema = z.object({
  password: z.string().min(1, 'Informe a senha atual'),
  code: mfaCodeSchema,
});
export type MfaConfirmInput = z.infer<typeof mfaConfirmSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email('E-mail inválido'),
});
export const resetPasswordSchema = z.object({
  token: z.string().min(16).max(255),
  password: passwordSchema,
});
/** Troca de senha com login (RF-017): a atual confirma que é o titular; a nova segue o cadastro. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Informe a senha atual'),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export const verifyEmailSchema = z.object({
  token: z.string().min(16).max(255),
});

/**
 * Pedido de troca de e-mail (RF-017): a senha atual confirma o titular. O endereço novo vai sem
 * espaços e em minúsculas (o login compara sem diferenciar maiúsculas, pela collation).
 */
export const changeEmailSchema = z.object({
  currentPassword: z.string().min(1, 'Informe a senha atual'),
  newEmail: z.string().trim().toLowerCase().max(255, 'E-mail inválido').email('E-mail inválido'),
});
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>;
/** Confirmação da troca pelo token do link enviado ao endereço novo (uso único). */
export const confirmEmailChangeSchema = z.object({
  token: z.string().min(16).max(255),
});

export const PHONE_INVALID_MESSAGE =
  'Telefone inválido: use um número do Brasil com DDD, como (47) 99999-1234';

/** Telefone da conta (RF-017): opcional; vazio ou null apaga; o que vier é guardado em E.164. */
export const updatePhoneSchema = z.object({
  phone: z
    .string()
    .max(30, PHONE_INVALID_MESSAGE)
    .nullable()
    .transform((value, ctx) => {
      if (value === null || value.trim() === '') return null;
      const phone = normalizeBrazilPhone(value);
      if (phone) return phone;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PHONE_INVALID_MESSAGE });
      return z.NEVER;
    }),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token obrigatório'),
});
export type RefreshInput = z.infer<typeof refreshSchema>;
