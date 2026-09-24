import { z } from 'zod';
import { env } from '../../config/env';
import { isPushEndpointAllowed } from './push.endpoint';
import { BRAZIL_TIMEZONES } from '../../utils/timezone';

/** Janela de silêncio dos avisos no navegador (ADR 54): objeto inteiro ou null, nunca meia janela. */
const quietHoursSchema = z
  .object({
    start: z.number().int().min(0).max(23),
    end: z.number().int().min(0).max(23),
  })
  .refine((q) => q.start !== q.end, {
    message: 'Início e fim iguais não formam uma janela de silêncio; para desligar, envie null',
  });

/**
 * Preferências de aviso (ADR 27, 42, 46 e 54): frequência dos e-mails, hora do resumo, fuso e a
 * janela de silêncio do push. É um PUT parcial: pelo menos um dos quatro.
 */
export const emailPreferenceSchema = z
  .object({
    emailFrequency: z.enum(['instant', 'daily', 'off']).optional(),
    /** Hora no fuso da conta; null volta à hora padrão da plataforma. */
    digestHour: z.number().int().min(0).max(23).nullable().optional(),
    /** Fuso do Brasil (ADR 46); null volta a Brasília. */
    timezone: z.enum(BRAZIL_TIMEZONES).nullable().optional(),
    /** Horas cheias no fuso da conta, [start, end); null desliga (ADR 54). */
    quietHours: quietHoursSchema.nullable().optional(),
  })
  .refine(
    (b) =>
      b.emailFrequency !== undefined ||
      b.digestHour !== undefined ||
      b.timezone !== undefined ||
      b.quietHours !== undefined,
    {
      message: 'Informe a frequência dos e-mails, a hora do resumo, o fuso ou a janela de silêncio',
    },
  );

export const notificationIdSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * Assinatura de push de um aparelho (ADR 52): o endpoint e as chaves que o navegador dá. O
 * endpoint precisa ser de um serviço de push conhecido quando o envio é real, porque quem faz a
 * requisição é a API.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(512)
    .refine((value) => isPushEndpointAllowed(value, env.PUSH_PROVIDER === 'webpush'), {
      message: 'Endereço de push não aceito',
    }),
  p256dh: z.string().min(8).max(255),
  auth: z.string().min(4).max(255),
});

/** Desligar este aparelho: basta o endpoint. */
export const pushEndpointSchema = z.object({ endpoint: z.string().url().max(512) });

/** Estado do push: com o endpoint do aparelho, diz se a assinatura dele é desta conta. */
export const pushStatusQuerySchema = z.object({
  endpoint: z.string().url().max(512).optional(),
});

export const listNotificationsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;
