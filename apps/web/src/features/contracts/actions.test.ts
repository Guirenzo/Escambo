import { describe, expect, it } from 'vitest';
import { contractActions, partyOf } from './actions';

const base = {
  clientId: 1,
  freelancerId: 2,
  hasReview: false,
  hasMilestones: false,
  deadlineAt: null,
} as const;
const keys = (status: string, userId: number, hasReview = false) =>
  contractActions({ ...base, status: status as never, hasReview }, userId).map((a) => a.key);
const labels = (o: Partial<Parameters<typeof contractActions>[0]>, userId: number, now?: number) =>
  contractActions({ ...base, status: 'accepted', ...o }, userId, now).map((a) => a.label);

describe('contractActions (ações por status e papel)', () => {
  it('identifica o papel do usuário', () => {
    expect(partyOf(base, 1)).toBe('client');
    expect(partyOf(base, 2)).toBe('freelancer');
    expect(partyOf(base, 3)).toBe('none');
  });

  it('proposta pendente: freelancer aceita/recusa, cliente cancela; ainda sem disputa', () => {
    expect(keys('pending', 2)).toEqual(['accept', 'reject']);
    expect(keys('pending', 1)).toEqual(['cancel']);
  });

  it('em andamento: freelancer entrega ou desiste, cliente cancela; os dois podem abrir disputa', () => {
    expect(keys('accepted', 2)).toEqual(['deliver', 'cancel', 'dispute']);
    expect(labels({}, 2)).toEqual(['Registrar entrega', 'Desistir', 'Abrir disputa']);
    expect(keys('accepted', 1)).toEqual(['cancel', 'dispute']);
    expect(labels({}, 1)).toEqual(['Cancelar', 'Abrir disputa']);
  });

  it('em revisão ninguém cancela (a API respondia 409): freelancer entrega, cliente só disputa', () => {
    expect(keys('revision_requested', 2)).toEqual(['deliver', 'dispute']);
    expect(keys('revision_requested', 1)).toEqual(['dispute']);
  });

  it('por marcos: o freelancer também pode desistir', () => {
    expect(labels({ hasMilestones: true, status: 'in_progress' }, 2)).toEqual([
      'Desistir',
      'Abrir disputa',
    ]);
    expect(labels({ hasMilestones: true, status: 'in_progress' }, 1)).toEqual([
      'Cancelar',
      'Abrir disputa',
    ]);
  });

  it('proposta com o prazo de entrega vencido: o freelancer só recusa', () => {
    const deadlineAt = '2026-10-02T02:59:59.000Z';
    const before = Date.parse('2026-10-01T15:00:00Z');
    const after = Date.parse('2026-10-02T15:00:00Z');
    expect(labels({ status: 'pending', deadlineAt }, 2, before)).toEqual(['Aceitar', 'Recusar']);
    expect(labels({ status: 'pending', deadlineAt }, 2, after)).toEqual(['Recusar']);
  });

  it('entregue: cliente aprova, pede revisão ou disputa; freelancer só disputa', () => {
    expect(keys('delivered', 1)).toEqual(['approve', 'revision', 'dispute']);
    expect(keys('delivered', 2)).toEqual(['dispute']);
  });

  it('concluída: cliente avalia uma vez; em disputa ninguém age', () => {
    expect(keys('completed', 1)).toEqual(['review']);
    expect(keys('completed', 1, true)).toEqual([]);
    expect(keys('completed', 2)).toEqual([]);
    expect(keys('disputed', 1)).toEqual([]);
  });

  it('quem não participa não tem ações; estados finais não têm ações', () => {
    expect(keys('pending', 3)).toEqual([]);
    expect(keys('cancelled', 1)).toEqual([]);
    expect(keys('rejected', 2)).toEqual([]);
  });

  it('entrega e revisão pedem um texto ao usuário', () => {
    const deliver = contractActions({ ...base, status: 'accepted' }, 2)[0];
    const revision = contractActions({ ...base, status: 'delivered' }, 1)[1];
    expect(deliver?.prompt).toBeTruthy();
    expect(revision?.prompt).toBeTruthy();
  });
});
