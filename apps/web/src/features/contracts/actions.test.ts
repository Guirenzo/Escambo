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

  it('proposta pendente: freelancer aceita/recusa, cliente cancela; ainda sem disputa', () => {
    expect(keys('pending', 2)).toEqual(['accept', 'reject']);
    expect(keys('pending', 1)).toEqual(['cancel']);
  });

  it('em andamento: freelancer entrega, cliente cancela; os dois podem abrir disputa', () => {
    expect(keys('accepted', 2)).toEqual(['deliver', 'dispute']);
    expect(keys('revision_requested', 2)).toEqual(['deliver', 'dispute']);
    expect(keys('accepted', 1)).toEqual(['cancel', 'dispute']);
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
