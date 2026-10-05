import { describe, expect, it } from 'vitest';
import { createContractSchema } from './contracts.schema';

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
