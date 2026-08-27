import { z } from 'zod';

export const notificationIdSchema = z.object({ id: z.coerce.number().int().positive() });

export const listNotificationsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;
