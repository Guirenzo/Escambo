import { z } from 'zod';

export const contractIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const messageIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const MESSAGE_MAX_LENGTH = 2000;

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1, 'Mensagem vazia').max(MESSAGE_MAX_LENGTH),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/** Campos de texto que acompanham o arquivo no multipart (legenda opcional). */
export const attachmentBodySchema = z.object({
  content: z.string().trim().max(MESSAGE_MAX_LENGTH).optional(),
});
