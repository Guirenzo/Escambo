import { describe, expect, it } from 'vitest';
import { contractActions, partyOf } from './actions';

const base = { clientId: 1, freelancerId: 2, hasReview: false } as const;
const keys = (status: string, userId: number, hasReview = false) =>
  contractActions({ ...base, status: status as never, hasReview }, userId).map((a) => a.key);

describe('contractActions (ações por status e papel)', () => {
  it('identifica o papel do usuário', () => {
    expect(partyOf(base, 1)).toBe('client');
    expect(partyOf(base, 2)).toBe('freelancer');
    expect(partyOf(base, 3)).toBe('none');
  });

  it('proposta pendente: freelancer aceita/recusa, cliente cancela', () => {
    expect(keys('pending', 2)).toEqual(['accept', 'reject']);
    expect(keys('pending', 1)).toEqual(['cancel']);
  });

  it('em andamento: só o freelancer entrega; cliente pode cancelar', () => {
    expect(keys('accepted', 2)).toEqual(['deliver']);
    expect(keys('revision_requested', 2)).toEqual(['deliver']);
    expect(keys('accepted', 1)).toEqual(['cancel']);
  });

  it('entregue: só o cliente aprova ou pede revisão', () => {
    expect(keys('delivered', 1)).toEqual(['approve', 'revision']);
    expect(keys('delivered', 2)).toEqual([]);
  });

  it('concluída: cliente avalia uma vez', () => {
    expect(keys('completed', 1)).toEqual(['review']);
    expect(keys('completed', 1, true)).toEqual([]);
    expect(keys('completed', 2)).toEqual([]);
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
