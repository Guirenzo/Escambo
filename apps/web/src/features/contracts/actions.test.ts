import { describe, expect, it } from 'vitest';
import { contractActions, partyOf } from './actions';
import type { Negotiation } from '@escambo/types';

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

describe('negociação: vez e oferta vista', () => {
  const now = Date.parse('2026-10-08T15:00:00Z');
  const negotiation = (seq: number): Negotiation => ({
    seq,
    turn: seq % 2 ? 'freelancer' : 'client',
    round: Math.ceil(seq / 2) as 1 | 2 | 3,
    canCounter: seq < 5,
    countersLeft: Math.ceil((5 - seq) / 2),
    current: null,
    respondBy: '2026-10-09T15:00:00Z',
  });
  const negotiated = (seq: number, userId: number, extra: Partial<Negotiation> = {}) =>
    contractActions(
      { ...base, status: 'pending', negotiation: { ...negotiation(seq), ...extra } },
      userId,
      now,
    ).map((a) => a.key);

  it.each([1, 3])(
    'oferta %i do cliente: só o freelancer aceita/contrapõe, cliente encerra',
    (seq) => {
      expect(negotiated(seq, 2)).toEqual(['accept', 'counter', 'reject']);
      expect(negotiated(seq, 1)).toEqual(['cancel']);
    },
  );
  it.each([2, 4])(
    'oferta %i do freelancer: só o cliente aceita/contrapõe, freelancer sai',
    (seq) => {
      expect(negotiated(seq, 1)).toEqual(['accept_counter', 'counter', 'cancel']);
      expect(negotiated(seq, 2)).toEqual(['reject']);
    },
  );
  it('seq 5 só permite aceite/recusa do freelancer e encerramento pelo cliente', () => {
    expect(negotiated(5, 2)).toEqual(['accept', 'reject']);
    expect(negotiated(5, 1)).toEqual(['cancel']);
    expect(negotiated(5, 2, { canCounter: true })).toEqual(['accept', 'reject']);
  });
  it('o instante limite já expirou: nem aceita nem contrapõe', () => {
    expect(negotiated(3, 2, { respondBy: '2026-10-08T15:00:00Z' })).toEqual(['reject']);
    expect(negotiated(4, 1, { respondBy: '2026-10-08T15:00:00Z' })).toEqual(['cancel']);
  });
  it('API pode retirar contraproposta antes da última rodada', () => {
    expect(negotiated(2, 1, { canCounter: false })).toEqual(['accept_counter', 'cancel']);
    expect(negotiated(2, 99)).toEqual([]);
  });
  it('troca continua com as ações antigas mesmo se houver dados de negociação', () => {
    expect(
      contractActions(
        { ...base, status: 'pending', paymentMode: 'barter', negotiation: negotiation(2) },
        1,
        now,
      ).map((a) => a.key),
    ).toEqual(['cancel']);
  });
});

describe('revisões e janela manual de disputa', () => {
  it('revisões esgotadas escondem o pedido e só o freelancer pode liberar mais uma', () => {
    const c = { ...base, status: 'delivered' as const, revisions: { used: 2, limit: 2 } };
    expect(contractActions(c, 1).map((a) => a.key)).toEqual(['approve', 'dispute']);
    expect(contractActions(c, 2).map((a) => a.key)).toEqual(['grant_revision', 'dispute']);
    expect(contractActions({ ...c, hasMilestones: true }, 2).map((a) => a.key)).toEqual([
      'dispute',
    ]);
    expect(contractActions({ ...c, status: 'revision_requested' }, 2).map((a) => a.key)).toEqual([
      'deliver',
      'dispute',
    ]);
  });
  it('o legado ilimitado mantém revisão disponível mesmo depois do pedido 255', () => {
    const c = { ...base, status: 'delivered' as const, revisions: { used: 300, limit: null } };
    expect(contractActions(c, 1).map((a) => a.key)).toEqual(['approve', 'revision', 'dispute']);
    expect(contractActions(c, 2).map((a) => a.key)).toEqual(['dispute']);
  });
  it('limite liberado reabre o pedido sem zerar o uso', () => {
    const c = { ...base, status: 'delivered' as const, revisions: { used: 2, limit: 3 } };
    expect(contractActions(c, 1).map((a) => a.key)).toEqual(['approve', 'revision', 'dispute']);
    expect(contractActions(c, 2).map((a) => a.key)).toEqual(['dispute']);
  });
  it.each(['accepted', 'in_progress', 'delivered', 'revision_requested'] as const)(
    'janela futura esconde disputa em %s para ambas as partes, abrindo no instante exato',
    (status) => {
      const c = { ...base, status, disputeOpensAt: '2026-10-08T15:00:00Z' };
      for (const id of [1, 2]) {
        expect(
          contractActions(c, id, Date.parse(c.disputeOpensAt) - 1).map((a) => a.key),
        ).not.toContain('dispute');
        expect(contractActions(c, id, Date.parse(c.disputeOpensAt)).map((a) => a.key)).toContain(
          'dispute',
        );
      }
    },
  );
});
