import { z } from 'zod';

/**
 * Erro do navegador enviado pelo app (RNF-040). Os tetos cortam o relato em vez de recusar: um
 * stack trace comprido ainda serve. O caminho chega sem query string nem âncora (o app corta),
 * e é cortado de novo aqui, porque a query de /redefinir-senha leva o token.
 */
export const clientErrorSchema = z
  .object({
    kind: z.enum(['render', 'error', 'rejection']),
    message: z
      .string()
      .min(1)
      .transform((s) => s.slice(0, 500)),
    stack: z
      .string()
      .optional()
      .transform((s) => s?.slice(0, 4000)),
    componentStack: z
      .string()
      .optional()
      .transform((s) => s?.slice(0, 4000)),
    path: z
      .string()
      .max(2000)
      .transform((s) => s.split(/[?#]/)[0]!.slice(0, 300)),
  })
  .strict();

export type ClientErrorInput = z.infer<typeof clientErrorSchema>;
