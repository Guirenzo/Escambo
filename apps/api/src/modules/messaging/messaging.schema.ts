import { z } from 'zod';

export const contractIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1, 'Mensagem vazia').max(2000),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
