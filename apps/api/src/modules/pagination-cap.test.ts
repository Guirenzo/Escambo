import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { listContractsSchema } from './contracts/contracts.schema';
import { listNotificationsSchema } from './notifications/notifications.schema';
import { listReviewsSchema } from './reviews/reviews.schema';
import { listServicesSchema } from './services/services.schema';

/**
 * Teto da página nas listas (ADR 60): o número da página vira OFFSET no SQL, e `?page=1e20` passava
 * na validação e derrubava a consulta com 500. Acima de 10000 é erro de validação, como nas listas
 * de dinheiro.
 */
/** A lista, o schema e o que mais ele exige (as avaliações são de um freelancer). */
const LISTS: [string, ZodTypeAny, Record<string, string>][] = [
  ['contratações', listContractsSchema, {}],
  ['notificações', listNotificationsSchema, {}],
  ['avaliações', listReviewsSchema, { freelancerId: '7' }],
  ['serviços', listServicesSchema, {}],
];

describe('teto da página nas listas', () => {
  it.each(LISTS)(
    '%s: a página 10000 passa; 10001 e 1e20 são recusadas no campo page',
    (_, schema, base) => {
      expect(schema.safeParse({ ...base, page: '10000' }).success).toBe(true);
      for (const page of ['10001', '1e20']) {
        const r = schema.safeParse({ ...base, page });
        expect(r.success).toBe(false);
        if (!r.success) expect(Object.keys(r.error.flatten().fieldErrors)).toContain('page');
      }
    },
  );
});
