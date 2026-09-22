import { z } from 'zod';
import { env } from '../../config/env';
import { isPushEndpointAllowed } from './push.endpoint';
import { BRAZIL_TIMEZONES } from '../../utils/timezone';

/** Frequência dos e-mails e hora do resumo do dia (ADR 27 e 42): pelo menos um dos dois. */
export const emailPreferenceSchema = z
  .object({
    emailFrequency: z.enum(['instant', 'daily', 'off']).optional(),
    /** Hora no fuso da conta; null volta à hora padrão da plataforma. */
    digestHour: z.number().int().min(0).max(23).nullable().optional(),
    /** Fuso do Brasil (ADR 46); null volta a Brasília. */
    timezone: z.enum(BRAZIL_TIMEZONES).nullable().optional(),
  })
  .refine(
    (b) => b.emailFrequency !== undefined || b.digestHour !== undefined || b.timezone !== undefined,
    {
      message: 'Informe a frequência dos e-mails, a hora do resumo ou o fuso',
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
