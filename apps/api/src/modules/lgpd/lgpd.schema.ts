import { z } from 'zod';
import { isLegalDocument, PUBLISHED_LEGAL_VERSIONS } from './legal-versions';

export const recordConsentSchema = z
  .object({
    type: z.enum(['terms_of_use', 'privacy_policy', 'marketing', 'data_processing']),
    version: z.string().min(1).max(20),
    accepted: z.boolean(),
  })
  // Termos e política só em versão publicada: a trilha não pode citar um texto que não existe.
  .refine((c) => !isLegalDocument(c.type) || PUBLISHED_LEGAL_VERSIONS[c.type].includes(c.version), {
    message: 'Versão desconhecida deste documento',
    path: ['version'],
  });
export type RecordConsentInput = z.infer<typeof recordConsentSchema>;

export const deletionRequestSchema = z.object({
  reason: z.string().max(1000).nullable().optional(),
});
export type DeletionRequestInput = z.infer<typeof deletionRequestSchema>;

export const exportIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
