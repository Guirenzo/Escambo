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
