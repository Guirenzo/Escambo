import { z } from 'zod';

/** Validação de entrada (RNF-015: schema em 100% das rotas). */

export const registerSchema = z.object({
  email: z.string().email('E-mail inválido'),
  password: z.string().min(8, 'A senha deve ter ao menos 8 caracteres'),
  role: z.enum(['client', 'freelancer', 'company']).default('client'),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email('E-mail inválido'),
  password: z.string().min(1, 'Senha obrigatória'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email('E-mail inválido'),
});
export const resetPasswordSchema = z.object({
  token: z.string().min(16).max(255),
  password: z.string().min(8, 'A senha deve ter ao menos 8 caracteres'),
});
export const verifyEmailSchema = z.object({
  token: z.string().min(16).max(255),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token obrigatório'),
});
export type RefreshInput = z.infer<typeof refreshSchema>;
