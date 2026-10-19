import type { CounterOfferRequest } from '@escambo/types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  cancelBodySchema,
  counterOfferSchema,
  createContractSchema,
  grantRevisionBodySchema,
  listContractsSchema,
  offerAcceptParamsSchema,
  offerDecisionBodySchema,
  type CounterOfferInput,
} from './contracts.schema';

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (days: number): string => new Date(NOW + days * DAY).toISOString();

const base = {
  freelancerId: 2,
  title: 'Site institucional',
  description: 'Site com três páginas e formulário de contato',
  price: 300,
  deadlineAt: iso(10),
};
const ms = (dues: (string | null)[]) =>
  dues.map((dueAt, i) => ({ title: `Etapa ${i + 1}`, amount: 100, dueAt }));
const messages = (input: unknown): string[] =>
  createContractSchema.safeParse(input).error?.issues.map((i) => i.message) ?? [];

describe('liberação de uma revisão: corpo vazio', () => {
  it('corpo ausente ou vazio concede a ação sem receber contador/limite do cliente', () => {
    expect(grantRevisionBodySchema.parse(undefined)).toEqual({});
    expect(grantRevisionBodySchema.parse({})).toEqual({});
    for (const body of [{ limit: 3 }, { used: 0 }, { note: 'Outra' }, null, []])
      expect(grantRevisionBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('cancelamento: contagem informativa opcional da RN-026', () => {
  it('conserva reembolso e sequência; aceita somente contador positivo inteiro', () => {
    expect(
      cancelBodySchema.parse({ expectedRefund: 100, seq: 1, expectedDropoutCount: 3 }),
    ).toEqual({ expectedRefund: 100, seq: 1, expectedDropoutCount: 3 });
    expect(cancelBodySchema.parse(undefined)).toEqual({});
    for (const value of [0, -1, 1.5, '3', null])
      expect(cancelBodySchema.safeParse({ expectedDropoutCount: value }).success).toBe(false);
    expect(cancelBodySchema.safeParse({ expectedDropoutCount: 3, freelancerId: 7 }).success).toBe(
      false,
    );
  });
});

describe('counterOfferSchema: termos completos da negociação (RN-030)', () => {
  const offer = { seq: 1, price: 300, deadlineAt: iso(10), message: 'Ajustar escopo e prazo' };
  const milestones = [
    { id: 11, amount: 150, dueAt: iso(3) },
    { id: 12, amount: 150, dueAt: iso(6) },
  ];
  const fields = (input: unknown) =>
    counterOfferSchema.safeParse(input).error?.issues.map((issue) => issue.path.join('.')) ?? [];

  it('aceita entrega única com prazo ou null, e preserva os ids/valores/datas dos marcos', () => {
    expect(counterOfferSchema.parse({ ...offer, deadlineAt: null })).toEqual({
      ...offer,
      deadlineAt: null,
    });
    expect(counterOfferSchema.parse({ ...offer, milestones })).toEqual({ ...offer, milestones });
    expectTypeOf<CounterOfferInput>().toEqualTypeOf<CounterOfferRequest>();
    expect(counterOfferSchema.parse({ ...offer, message: '  Revisar preço  ' }).message).toBe(
      'Revisar preço',
    );
  });

  it('seq, preço, prazo nullable e mensagem são obrigatórios; sequência vai de 1 a 5', () => {
    for (const key of ['seq', 'price', 'deadlineAt', 'message']) {
      const incomplete: Record<string, unknown> = { ...offer };
      delete incomplete[key];
      expect(fields(incomplete), key).toContain(key);
    }
    for (const seq of [1, 2, 3, 4, 5])
      expect(counterOfferSchema.safeParse({ ...offer, seq }).success).toBe(true);
    for (const seq of [0, 6, 1.5, '2', null])
      expect(fields({ ...offer, seq }), String(seq)).toContain('seq');
  });

  it('mensagem tem de 5 a 500 caracteres depois de retirar espaços nas pontas', () => {
    for (const message of ['     ', '  abc  ', 'x'.repeat(501)]) {
      expect(fields({ ...offer, message })).toContain('message');
    }
    for (const message of ['cinco', 'x'.repeat(500)]) {
      expect(counterOfferSchema.safeParse({ ...offer, message }).success).toBe(true);
    }
  });

  it('dinheiro aceita centavos exatos no mínimo e teto, e barra frações/valores não finitos', () => {
    for (const price of [10, 10.01, 1234.56, 99_999_999.99]) {
      expect(counterOfferSchema.safeParse({ ...offer, price }).success, String(price)).toBe(true);
    }
    for (const price of [9.99, 10.005, 100_000_000, NaN, Infinity, -Infinity]) {
      expect(fields({ ...offer, price }), String(price)).toContain('price');
    }
    expect(
      fields({
        ...offer,
        milestones: [
          { ...milestones[0], amount: 150.005 },
          { ...milestones[1], amount: 149.995 },
        ],
      }),
    ).toEqual(expect.arrayContaining(['milestones.0.amount', 'milestones.1.amount']));
  });

  it('marcos são de 2 a 10, ids inteiros positivos únicos, com dueAt explícito', () => {
    for (const invalid of [
      [],
      [milestones[0]],
      Array.from({ length: 11 }, (_, i) => ({ id: i + 1, amount: 1, dueAt: null })),
    ]) {
      expect(fields({ ...offer, milestones: invalid })).toContain('milestones');
    }
    for (const id of [0, -1, 1.5]) {
      expect(fields({ ...offer, milestones: [{ ...milestones[0], id }, milestones[1]] })).toContain(
        'milestones.0.id',
      );
    }
    expect(fields({ ...offer, milestones: [milestones[0], milestones[0]] })).toContain(
      'milestones',
    );
    expect(fields({ ...offer, milestones: [{ id: 11, amount: 150 }, milestones[1]] })).toContain(
      'milestones.0.dueAt',
    );
    expect(
      counterOfferSchema.safeParse({
        ...offer,
        price: 10,
        milestones: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, amount: 1, dueAt: null })),
      }).success,
    ).toBe(true);
  });

  it('soma dos marcos é exata em centavos; uma diferença de um centavo é recusada', () => {
    expect(
      counterOfferSchema.safeParse({
        ...offer,
        price: 10.01,
        milestones: [
          { id: 11, amount: 10, dueAt: null },
          { id: 12, amount: 0.01, dueAt: null },
        ],
      }).success,
    ).toBe(true);
    expect(
      fields({ ...offer, milestones: [{ ...milestones[0], amount: 149.99 }, milestones[1]] }),
    ).toContain('milestones');
    for (const amount of [0, -1, NaN, Infinity, 100_000_000]) {
      expect(
        fields({ ...offer, milestones: [{ ...milestones[0], amount }, milestones[1]] }),
      ).toContain('milestones.0.amount');
    }
  });

  it('prazos ficam no futuro e em ordem, inclusive através de marco sem prazo', () => {
    expect(fields({ ...offer, deadlineAt: iso(-1) })).toContain('deadlineAt');
    expect(fields({ ...offer, deadlineAt: 'amanhã' })).toContain('deadlineAt');
    expect(
      fields({ ...offer, milestones: [{ ...milestones[0], dueAt: iso(-1) }, milestones[1]] }),
    ).toContain('milestones.0.dueAt');
    expect(
      fields({ ...offer, milestones: [{ ...milestones[0], dueAt: iso(7) }, milestones[1]] }),
    ).toContain('milestones.1.dueAt');
    expect(
      fields({ ...offer, milestones: [milestones[0], { ...milestones[1], dueAt: iso(11) }] }),
    ).toContain('milestones.1.dueAt');
    expect(
      counterOfferSchema.safeParse({
        ...offer,
        milestones: [{ ...milestones[0], dueAt: iso(6) }, milestones[1]],
      }).success,
    ).toBe(true);
    expect(
      fields({
        ...offer,
        milestones: [
          { id: 11, amount: 100, dueAt: iso(7) },
          { id: 12, amount: 100, dueAt: null },
          { id: 13, amount: 100, dueAt: iso(6) },
        ],
      }),
    ).toContain('milestones.2.dueAt');
  });

  it('não recebe títulos, forma de pagamento, líquido ou reserva calculados pelo cliente', () => {
    for (const extra of [
      { paymentMode: 'credits' },
      { title: 'Outro contrato' },
      { freelancerNet: 1 },
      { platformFee: 0 },
    ]) {
      expect(counterOfferSchema.safeParse({ ...offer, ...extra }).success).toBe(false);
    }
    expect(
      counterOfferSchema.safeParse({
        ...offer,
        milestones: [{ ...milestones[0], title: 'Trocar título' }, milestones[1]],
      }).success,
    ).toBe(false);
    expect(counterOfferSchema.safeParse({ ...offer, milestones: null }).success).toBe(false);
  });
});

describe('schemas da decisão: sequência vista e compatibilidade da oferta 1', () => {
  it('accept/reject admitem corpo vazio ou seq inteiro de 1 a 5; rejeitam seq inválido/extra', () => {
    expect(offerDecisionBodySchema.parse(undefined)).toEqual({});
    expect(offerDecisionBodySchema.parse({})).toEqual({});
    for (const seq of [1, 2, 3, 4, 5])
      expect(offerDecisionBodySchema.parse({ seq })).toEqual({ seq });
    for (const seq of [0, 6, 1.5, '1', null])
      expect(offerDecisionBodySchema.safeParse({ seq }).success).toBe(false);
    expect(offerDecisionBodySchema.safeParse({ seq: 1, price: 999 }).success).toBe(false);
  });

  it('aceite de contraproposta recebe id e seq da rota, ambos válidos', () => {
    expect(offerAcceptParamsSchema.parse({ id: '12', seq: '2' })).toEqual({ id: 12, seq: 2 });
    for (const seq of ['0', '6', '1.5', 'abc'])
      expect(offerAcceptParamsSchema.safeParse({ id: '12', seq }).success).toBe(false);
    expect(offerAcceptParamsSchema.safeParse({ id: '0', seq: '2' }).success).toBe(false);
  });

  it('cancelamento conserva expectedRefund e valida a sequência quando presente', () => {
    expect(cancelBodySchema.parse({ expectedRefund: 250, seq: 2 })).toEqual({
      expectedRefund: 250,
      seq: 2,
    });
    expect(cancelBodySchema.parse(undefined)).toEqual({});
    for (const seq of [0, 6, 1.5, '2'])
      expect(cancelBodySchema.safeParse({ seq }).success).toBe(false);
  });
});

describe('createContractSchema: marcos em créditos', () => {
  it('aceita marcos inteiros e recusa fração de crédito', () => {
    const credits = { ...base, paymentMode: 'credits' as const, price: 80 };
    expect(
      createContractSchema.safeParse({
        ...credits,
        milestones: [
          { title: 'Visita 1', amount: 40 },
          { title: 'Visita 2', amount: 40 },
        ],
      }).success,
    ).toBe(true);
    expect(
      messages({
        ...credits,
        milestones: [
          { title: 'Visita 1', amount: 40.5 },
          { title: 'Visita 2', amount: 39.5 },
        ],
      }),
    ).toContain('O marco 1 precisa ter um número inteiro de créditos');
  });
});

describe('createContractSchema: teto do valor', () => {
  it('valor da contratação vai até R$ 99.999.999,99 (DECIMAL(10,2)); acima disso é recusado com a mensagem do teto', () => {
    const top = { ...base, deadlineAt: null };
    expect(createContractSchema.safeParse({ ...top, price: 99_999_999.99 }).success).toBe(true);
    const over = createContractSchema.safeParse({ ...top, price: 100_000_000 });
    expect(over.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['price', 'O valor máximo é R$ 99.999.999,99'],
    ]);
  });

  it('o valor de cada marco tem o mesmo teto', () => {
    const top = { ...base, deadlineAt: null, price: 99_999_999.99 };
    expect(
      createContractSchema.safeParse({
        ...top,
        milestones: [
          { title: 'Etapa 1', amount: 99_999_998.99 },
          { title: 'Etapa 2', amount: 1 },
        ],
      }).success,
    ).toBe(true);
    const over = createContractSchema.safeParse({
      ...top,
      milestones: [
        { title: 'Etapa 1', amount: 100_000_000 },
        { title: 'Etapa 2', amount: 1 },
      ],
    });
    expect(over.error?.issues.map((i) => [i.path.join('.'), i.message])).toContainEqual([
      'milestones.0.amount',
      'O valor máximo é R$ 99.999.999,99',
    ]);
  });
});

describe('createContractSchema: centavo exato (ADR 60)', () => {
  const noDeadline = { ...base, deadlineAt: null };
  const priceIssues = (price: number) =>
    createContractSchema
      .safeParse({ ...noDeadline, price })
      .error?.issues.map((i) => [i.path.join('.'), i.message]);

  it('valor com fração de centavo é recusado no campo price (10,005 gravaria 10,01 e reservaria 10,00)', () => {
    for (const price of [10.005, 150.001, 99.999]) {
      expect(priceIssues(price)).toEqual([
        ['price', 'O valor vai até os centavos: no máximo duas casas decimais'],
      ]);
    }
  });

  it('valor com até duas casas passa, inclusive no mínimo e no teto', () => {
    for (const price of [10, 10.01, 10.1, 150.5, 1234.56, 99_999_999.99]) {
      expect(createContractSchema.safeParse({ ...noDeadline, price }).success).toBe(true);
    }
  });

  it('o valor de cada marco também vai só até os centavos', () => {
    const issues = createContractSchema
      .safeParse({
        ...noDeadline,
        price: 300,
        milestones: [
          { title: 'Etapa 1', amount: 150.005 },
          { title: 'Etapa 2', amount: 149.995 },
        ],
      })
      .error?.issues.map((i) => [i.path.join('.'), i.message]);
    expect(issues).toEqual([
      ['milestones.0.amount', 'O valor vai até os centavos: no máximo duas casas decimais'],
      ['milestones.1.amount', 'O valor vai até os centavos: no máximo duas casas decimais'],
    ]);
    expect(
      createContractSchema.safeParse({
        ...noDeadline,
        price: 300,
        milestones: [
          { title: 'Etapa 1', amount: 150.01 },
          { title: 'Etapa 2', amount: 149.99 },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('createContractSchema: prazos', () => {
  it('prazo da contratação precisa estar no futuro', () => {
    expect(createContractSchema.safeParse(base).success).toBe(true);
    expect(messages({ ...base, deadlineAt: iso(-1) })).toContain(
      'O prazo de entrega precisa estar no futuro',
    );
  });

  it('marcos sem prazo, ou com prazos crescentes até o prazo da contratação, passam', () => {
    expect(
      createContractSchema.safeParse({ ...base, milestones: ms([null, null, null]) }).success,
    ).toBe(true);
    expect(
      createContractSchema.safeParse({ ...base, milestones: ms([iso(3), iso(6), iso(10)]) })
        .success,
    ).toBe(true);
    // Sem prazo na contratação, os marcos só precisam estar no futuro e em ordem.
    expect(
      createContractSchema.safeParse({
        ...base,
        deadlineAt: null,
        milestones: ms([iso(3), null, iso(40)]),
      }).success,
    ).toBe(true);
  });

  it('recusa prazo de marco no passado, fora de ordem ou depois do prazo da contratação', () => {
    expect(messages({ ...base, milestones: ms([iso(-1), iso(6), iso(10)]) })).toContain(
      'O prazo do marco 1 precisa estar no futuro',
    );
    expect(messages({ ...base, milestones: ms([iso(6), iso(3), iso(10)]) })).toContain(
      'O prazo do marco 2 precisa ser igual ou depois do marco anterior',
    );
    expect(messages({ ...base, milestones: ms([iso(3), iso(6), iso(12)]) })).toContain(
      'O prazo do marco 3 não pode passar do prazo da contratação',
    );
  });
});

describe('listContractsSchema: filtro por status da lista (RF-040)', () => {
  it('sem status, não filtra; página e limite têm padrão', () => {
    expect(listContractsSchema.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it('aceita a lista separada por vírgula ou o parâmetro repetido, sem repetir status', () => {
    expect(listContractsSchema.parse({ status: 'accepted, in_progress,accepted' }).status).toEqual([
      'accepted',
      'in_progress',
    ]);
    expect(
      listContractsSchema.parse({ status: ['completed', 'cancelled,rejected'] }).status,
    ).toEqual(['completed', 'cancelled', 'rejected']);
  });

  it('status vazio vale como sem filtro', () => {
    expect(listContractsSchema.parse({ status: '' }).status).toBeUndefined();
    expect(listContractsSchema.parse({ status: ' , ' }).status).toBeUndefined();
  });

  it('status desconhecido é recusado com a mensagem em português', () => {
    const r = listContractsSchema.safeParse({ status: 'pending,pago' });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toEqual(['Status de contratação desconhecido']);
  });
});
