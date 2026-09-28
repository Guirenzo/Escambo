import { describe, expect, it } from 'vitest';
import { cancelTerms, cashSettlement, type CancelInput } from './cancel-policy';

/** Horário de Brasília (UTC−3). */
const brt = (s: string): Date => new Date(`${s.replace(' ', 'T')}-03:00`);
const SP = 'America/Sao_Paulo' as const;

/** Contratação de R$ 200 (líquido 170), aceita seg 10:00, prazo sex 23:59:59. */
const input = (over: Partial<CancelInput> = {}): CancelInput => ({
  by: 'client',
  status: 'accepted',
  paymentMode: 'cash',
  owes: true,
  deadlineAt: brt('2026-10-09 23:59:59'),
  acceptedAt: brt('2026-10-05 10:00:00'),
  createdAt: brt('2026-10-02 10:00:00'),
  noticeAt: null,
  extensionPending: false,
  deliveredAwaiting: 0,
  inRevision: 0,
  freelancerZone: SP,
  viewerZone: SP,
  now: brt('2026-10-06 10:00:00'),
  price: 200,
  net: 170,
  credits: 170,
  ...over,
});

describe('cancelTerms (RN-025, RN-026, ADR 57)', () => {
  it('1. proposta: o freelancer usa Recusar', () => {
    const t = cancelTerms(input({ status: 'pending', by: 'freelancer' }));
    expect(t).toMatchObject({ allowed: false, code: 'use_reject' });
    expect(t.message).toBe('Para não aceitar a proposta, use Recusar.');
  });

  it('2. proposta: o cliente retira e a reserva volta inteira', () => {
    expect(cancelTerms(input({ status: 'pending' }))).toMatchObject({
      allowed: true,
      stage: 'proposal',
      refundPercentage: 100,
      refundClient: 200,
      releaseFreelancer: 0,
      unit: 'BRL',
    });
    expect(cancelTerms(input({ status: 'pending', paymentMode: 'credits' }))).toMatchObject({
      stage: 'proposal',
      refundClient: 0,
      unit: 'credits',
    });
  });

  it('3. depois da entrega, em disputa ou encerrada: não se cancela, com a mensagem do status', () => {
    expect(cancelTerms(input({ status: 'delivered' })).message).toBe(
      'Depois da entrega não se cancela: aprove, peça revisão ou abra uma disputa.',
    );
    expect(cancelTerms(input({ status: 'revision_requested', by: 'freelancer' })).message).toBe(
      'Depois da entrega não se desiste: entregue a revisão, aguarde o cliente ou abra uma disputa.',
    );
    expect(cancelTerms(input({ status: 'disputed' })).message).toContain('mediação');
    expect(cancelTerms(input({ status: 'completed' }))).toMatchObject({
      allowed: false,
      code: 'invalid_transition',
      message: 'Esta contratação já foi encerrada.',
    });
  });

  it('4. marco entregue em aberto trava: esperando o cliente ou em revisão', () => {
    expect(cancelTerms(input({ deliveredAwaiting: 1 }))).toMatchObject({
      allowed: false,
      code: 'milestone_open',
    });
    expect(cancelTerms(input({ deliveredAwaiting: 1 })).message).toContain(
      'esperando a sua resposta',
    );
    expect(cancelTerms(input({ inRevision: 1 })).message).toContain('em revisão');
    expect(cancelTerms(input({ inRevision: 1, by: 'freelancer' })).message).toContain(
      'entregue de novo',
    );
  });

  it('5. troca: não move dinheiro aqui', () => {
    expect(cancelTerms(input({ paymentMode: 'barter' }))).toMatchObject({
      allowed: true,
      stage: 'barter',
      unit: 'none',
      refundClient: 0,
      releaseFreelancer: 0,
    });
  });

  it('6. créditos voltam inteiros, pelo cliente ou pelo freelancer', () => {
    expect(cancelTerms(input({ paymentMode: 'credits' }))).toMatchObject({
      stage: 'credits',
      refundPercentage: 100,
      refundClient: 170,
      unit: 'credits',
    });
    expect(cancelTerms(input({ paymentMode: 'credits', by: 'freelancer' }))).toMatchObject({
      stage: 'withdrawal',
      refundClient: 170,
    });
  });

  it('7. o freelancer que desiste devolve tudo ao cliente, com o prazo vencido ou não', () => {
    for (const now of [brt('2026-10-06 10:00:00'), brt('2026-10-12 10:00:00')]) {
      expect(cancelTerms(input({ by: 'freelancer', now }))).toMatchObject({
        allowed: true,
        stage: 'withdrawal',
        refundPercentage: 100,
        refundClient: 200,
        releaseFreelancer: 0,
      });
    }
  });

  it('8. sem prazo: 50%', () => {
    expect(cancelTerms(input({ deadlineAt: null }))).toMatchObject({
      stage: 'no_deadline',
      refundPercentage: 50,
      refundClient: 100,
      releaseFreelancer: 85,
    });
  });

  it('9. prazo vencido sem entrega, a partir do aviso: 100% (bug antigo: 0%)', () => {
    expect(
      cancelTerms(input({ now: brt('2026-10-10 09:30:00'), noticeAt: brt('2026-10-10 09:03:00') })),
    ).toMatchObject({
      stage: 'overdue',
      refundPercentage: 100,
      refundClient: 200,
      releaseFreelancer: 0,
    });
    // sem o aviso gravado (job parado), vale a hora prevista: as 9h depois do prazo
    expect(cancelTerms(input({ now: brt('2026-10-10 09:30:00') })).stage).toBe('overdue');
  });

  it('10. pedido de extensão esperando o cliente: responder antes de cancelar', () => {
    expect(
      cancelTerms(input({ now: brt('2026-10-10 12:00:00'), extensionPending: true })),
    ).toMatchObject({ allowed: false, code: 'extension_pending_answer' });
  });

  it('11. entre o prazo e o aviso das 9h: espera, com a hora', () => {
    const t = cancelTerms(input({ now: brt('2026-10-10 02:00:00') }));
    expect(t).toMatchObject({ allowed: false, code: 'wait_notice' });
    expect(t.availableAt).toBe(brt('2026-10-10 09:00:00').toISOString());
    expect(t.message).toBe(
      'O prazo venceu há pouco. sáb, 10/10 às 09:00 o Escambo avisa o freelancer; a partir daí, cancelar devolve tudo a você.',
    );
  });

  it('12 e 13. antes do prazo, a metade conta do aceite: 50% antes, 0% a partir dela', () => {
    // aceite seg 10:00 → prazo sex 23:59:59: metade em qua ~17:00
    expect(cancelTerms(input({ now: brt('2026-10-07 12:00:00') }))).toMatchObject({
      stage: 'early',
      refundPercentage: 50,
      refundClient: 100,
      releaseFreelancer: 85,
    });
    const late = cancelTerms(input({ now: brt('2026-10-08 12:00:00') }));
    expect(late).toMatchObject({
      stage: 'late',
      refundPercentage: 0,
      refundClient: 0,
      releaseFreelancer: 170,
    });
    expect(late.noticeAt).toBe(brt('2026-10-10 09:00:00').toISOString());
  });

  it('a proposta que esperou não come o tempo de quem contratou: conta do aceite, não da criação', () => {
    // criada 60 h antes do aceite; 40% do tempo desde o aceite → 50%, não 0%
    const acceptedAt = brt('2026-10-05 10:00:00');
    const deadline = brt('2026-10-09 23:59:59');
    const now = new Date(acceptedAt.getTime() + 0.4 * (deadline.getTime() - acceptedAt.getTime()));
    expect(
      cancelTerms(input({ createdAt: brt('2026-10-02 22:00:00'), acceptedAt, now })).stage,
    ).toBe('early');
  });

  it('borda: exatamente na metade dá 0%', () => {
    const acceptedAt = brt('2026-10-05 10:00:00');
    const deadline = brt('2026-10-09 22:00:00');
    const now = new Date((acceptedAt.getTime() + deadline.getTime()) / 2);
    expect(cancelTerms(input({ acceptedAt, deadlineAt: deadline, now })).stage).toBe('late');
  });

  it('por marcos, só o escrow que falta entra na conta', () => {
    expect(cancelTerms(input({ price: 666.67, net: 566.67, deadlineAt: null }))).toMatchObject({
      refundClient: 333.34,
      releaseFreelancer: 283.34,
    });
  });
});

describe('cashSettlement', () => {
  it('sem taxa em jogo e centavo ímpar, nunca sai mais do que o escrow', () => {
    // taxa 0%: preço = líquido; 50% de 10,01 arredondaria as duas metades para 5,01
    expect(cashSettlement(10.01, 10.01, 50)).toEqual({ refundClient: 5.01, releaseFreelancer: 5 });
    expect(cashSettlement(0.03, 0.03, 50)).toEqual({ refundClient: 0.02, releaseFreelancer: 0.01 });
    for (const [p, n] of [
      [10.01, 10.01],
      [123.45, 123.45],
      [99.99, 84.99],
      [0.03, 0.03],
    ] as const) {
      for (const pct of [0, 33, 50, 67, 100]) {
        const s = cashSettlement(p, n, pct);
        expect(Math.round((s.refundClient + s.releaseFreelancer) * 100)).toBeLessThanOrEqual(
          Math.round(p * 100),
        );
      }
    }
  });

  it('divide preço e líquido na mesma proporção, em centavos', () => {
    expect(cashSettlement(200, 170, 50)).toEqual({ refundClient: 100, releaseFreelancer: 85 });
    expect(cashSettlement(200, 170, 100)).toEqual({ refundClient: 200, releaseFreelancer: 0 });
    expect(cashSettlement(200, 170, 0)).toEqual({ refundClient: 0, releaseFreelancer: 170 });
  });
});
