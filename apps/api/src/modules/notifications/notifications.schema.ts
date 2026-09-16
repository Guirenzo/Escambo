import { z } from 'zod';
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

export const listNotificationsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;
