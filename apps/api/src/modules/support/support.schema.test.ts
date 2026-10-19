import { describe, expect, it } from 'vitest';
import {
  adminReplySupportSchema,
  closeSupportSchema,
  createSupportSchema,
  replySupportSchema,
  supportDetailSchema,
  supportIdSchema,
  supportListSchema,
  updateSupportSchema,
} from './support.schema';
const opening = {
  category: 'account',
  subject: 'Minha conta',
  description: 'Preciso consultar minha conta',
};
describe('schemas do atendimento privado', () => {
  it('normaliza texto e exige vínculo em dispute', () => {
    expect(
      createSupportSchema.parse({
        ...opening,
        subject: '  Minha conta  ',
        description: '  Solicito atendimento  ',
      }),
    ).toEqual({ category: 'account', subject: 'Minha conta', description: 'Solicito atendimento' });
    expect(createSupportSchema.safeParse({ ...opening, category: 'dispute' }).success).toBe(false);
    expect(
      createSupportSchema.safeParse({ ...opening, category: 'dispute', contractId: 4 }).success,
    ).toBe(true);
    expect(createSupportSchema.safeParse({ ...opening, contractId: null }).success).toBe(true);
  });
  it.each([
    { subject: 'ab' },
    { subject: 'a'.repeat(151) },
    { description: 'a'.repeat(9) },
    { description: 'a'.repeat(5001) },
    { category: 'urgent' },
    { contractId: 0 },
    { contractId: '4' },
    { userId: 5 },
    { status: 'closed' },
    { priority: 'critical' },
  ])('recusa abertura inválida ou controle do estado: %j', (extra) => {
    expect(createSupportSchema.safeParse({ ...opening, ...extra }).success).toBe(false);
  });
  it.each([{ internal: true }, { resolve: true }, { senderId: 5 }, { status: 'resolved' }])(
    'titular só envia message: %j',
    (extra) => {
      expect(replySupportSchema.safeParse({ message: 'Oi', ...extra }).success).toBe(false);
    },
  );
  it('admin tem defaults e nota interna não resolve', () => {
    expect(adminReplySupportSchema.parse({ message: '  Resposta  ' })).toEqual({
      message: 'Resposta',
      internal: false,
      resolve: false,
    });
    expect(
      adminReplySupportSchema.safeParse({ message: 'Nota', internal: true, resolve: true }).success,
    ).toBe(false);
    expect(adminReplySupportSchema.safeParse({ message: ' ', resolve: true }).success).toBe(false);
    expect(adminReplySupportSchema.safeParse({ message: 'a'.repeat(5001) }).success).toBe(false);
    expect(
      adminReplySupportSchema.safeParse({ message: 'a'.repeat(5000), resolve: true }).success,
    ).toBe(true);
  });
  it.each([
    {},
    { status: 'resolved' },
    { status: 'closed' },
    { assignedTo: 9 },
    { priority: 'urgent' },
  ])('PATCH não faz resolução silenciosa nem atribuição: %j', (body) => {
    expect(updateSupportSchema.safeParse(body).success).toBe(false);
  });
  it('PATCH aceita apenas estado operacional e prioridade', () => {
    expect(updateSupportSchema.parse({ priority: 'critical', status: 'waiting_user' })).toEqual({
      priority: 'critical',
      status: 'waiting_user',
    });
  });
  it('consulta limita paginação, cursor e não aceita filtros de outro dono', () => {
    expect(supportListSchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(supportListSchema.parse({ page: '2', limit: '50', status: 'resolved' })).toEqual({
      page: 2,
      limit: 50,
      status: 'resolved',
    });
    for (const q of [
      { page: 0 },
      { limit: 51 },
      { userId: 9 },
      { page: 1.2 },
      { status: 'deleted' },
    ]) {
      expect(supportListSchema.safeParse(q).success).toBe(false);
    }
    expect(supportDetailSchema.parse({ beforeId: '13' })).toEqual({ beforeId: 13 });
    expect(supportDetailSchema.safeParse({ beforeId: 0 }).success).toBe(false);
    expect(supportDetailSchema.safeParse({ internal: true }).success).toBe(false);
    expect(supportIdSchema.safeParse({ id: '9007199254740992' }).success).toBe(false);
    expect(closeSupportSchema.parse(undefined)).toEqual({});
    expect(closeSupportSchema.safeParse({ status: 'closed' }).success).toBe(false);
  });
});
