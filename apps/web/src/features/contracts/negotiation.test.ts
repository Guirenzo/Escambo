import type { ContractOffer } from '@escambo/types';
import { describe, expect, it } from 'vitest';
import { offerDraft, prepareCounter, reserveDelta, splitOfferAmounts } from './negotiation';

const offer = (patch: Partial<ContractOffer> = {}): ContractOffer => ({
  seq: 2,
  madeBy: 'freelancer',
  price: 100,
  platformFee: 15,
  freelancerNet: 85,
  deadlineAt: '2026-10-15T03:59:59.000Z',
  deadlineZone: 'America/Manaus',
  milestones: null,
  message: 'Preciso de mais prazo',
  respondBy: '2026-10-10T15:00:00Z',
  outcome: 'open',
  createdAt: '2026-10-08T15:00:00Z',
  resolvedAt: null,
  ...patch,
});
const minimum = '2026-10-09';

describe('contraproposta: termos fixos e validação antes do envio', () => {
  it('lê o dia em Manaus e converte o novo dia para 23:59:59 do mesmo fuso', () => {
    const current = offer();
    const draft = offerDraft(current);
    expect(draft.deadline).toBe('2026-10-14');
    draft.deadline = '2026-10-16';
    draft.message = '  Preciso destes dois dias  ';
    expect(prepareCounter(current, 'cash', draft, minimum)).toEqual({
      error: null,
      body: {
        seq: 2,
        price: 100,
        deadlineAt: '2026-10-17T03:59:59.000Z',
        message: 'Preciso destes dois dias',
      },
    });
  });
  it('mensagem sozinha não é uma contraproposta, mesmo com ISO equivalente', () => {
    const current = offer({ deadlineAt: '2026-10-14T23:59:59-04:00' });
    expect(
      prepareCounter(current, 'cash', { ...offerDraft(current), message: 'Outro texto' }, minimum)
        .error,
    ).toMatch(/Só a mensagem/);
  });
  it('mudança do fuso do freelancer conserva o dia legado e só converte depois de editar os termos', () => {
    const current = offer({
      milestones: [
        {
          id: 71,
          title: 'Primeiro',
          amount: 50,
          freelancerNet: 42.5,
          dueAt: '2026-10-13T03:59:59.000Z',
        },
        { id: 93, title: 'Segundo', amount: 50, freelancerNet: 42.5, dueAt: null },
      ],
    });
    const draft = { ...offerDraft(current), message: 'Explico os termos' };
    expect(draft.deadline).toBe('2026-10-14');
    expect(draft.milestones[0]!.due).toBe('2026-10-12');
    expect(prepareCounter(current, 'cash', draft, minimum, 'America/Sao_Paulo').error).toMatch(
      /Só a mensagem/,
    );
    draft.price = '110';
    draft.milestones[1]!.amount = '60';
    const body = prepareCounter(current, 'cash', draft, minimum, 'America/Sao_Paulo').body;
    expect(body?.deadlineAt).toBe('2026-10-15T02:59:59.000Z');
    expect(body?.milestones?.[0]?.dueAt).toBe('2026-10-13T02:59:59.000Z');
    expect(current.deadlineAt).toBe('2026-10-15T03:59:59.000Z');
  });
  it.each(['9.99', '20.001', '1e2', '', 'Infinity'])(
    'não arredonda nem envia valor inválido %s',
    (price) => {
      const current = offer();
      expect(
        prepareCounter(
          current,
          'cash',
          { ...offerDraft(current), price, message: 'Novo preço' },
          minimum,
        ).body,
      ).toBeNull();
    },
  );
  it('sem prazo continua sem prazo, sem inventar marcos', () => {
    const current = offer({ deadlineAt: null });
    const draft = { ...offerDraft(current), price: '110', message: 'Novo preço' };
    expect(prepareCounter(current, 'cash', draft, minimum).body).toEqual({
      seq: 2,
      price: 110,
      deadlineAt: null,
      message: 'Novo preço',
    });
    expect(
      prepareCounter(current, 'cash', { ...draft, deadline: '2026-10-16' }, minimum).error,
    ).toMatch(/existência do prazo/);
  });
  it.each(['2026-10-08', '2026-02-30', 'errada'])(
    'recusa dia passado ou inválido %s',
    (deadline) => {
      const current = offer();
      expect(
        prepareCounter(
          current,
          'cash',
          { ...offerDraft(current), deadline, message: 'Novo prazo' },
          minimum,
        ).body,
      ).toBeNull();
    },
  );
  it('créditos exigem inteiros no total e em cada marco', () => {
    const current = offer({ price: 30, platformFee: 0, freelancerNet: 30 });
    expect(
      prepareCounter(
        current,
        'credits',
        { ...offerDraft(current), price: '30.5', message: 'Outro valor' },
        minimum,
      ).body,
    ).toBeNull();
    expect(
      prepareCounter(
        current,
        'credits',
        { ...offerDraft(current), price: '31', message: 'Outro valor' },
        minimum,
      ).body?.price,
    ).toBe(31);
  });
  it('rateia o resto no último marco em centavos ou em créditos', () => {
    expect(splitOfferAmounts('10', 3, false)).toEqual(['3.33', '3.33', '3.34']);
    expect(splitOfferAmounts('10', 3, true)).toEqual(['3', '3', '4']);
    expect(splitOfferAmounts('10.001', 3, false)).toBeNull();
  });
  it('marcos mantêm ids/títulos/ordem e a soma exata; o payload só leva termos editáveis', () => {
    const current = offer({
      price: 10,
      milestones: [
        { id: 71, title: 'Primeiro', amount: 3.33, freelancerNet: 2.83, dueAt: null },
        { id: 93, title: 'Segundo', amount: 6.67, freelancerNet: 5.67, dueAt: null },
      ],
    });
    const draft = {
      ...offerDraft(current),
      message: 'Novo rateio',
      milestones: [
        { id: 71, title: 'Primeiro', amount: '3.34', due: '' },
        { id: 93, title: 'Segundo', amount: '6.66', due: '' },
      ],
    };
    expect(prepareCounter(current, 'cash', draft, minimum).body?.milestones).toEqual([
      { id: 71, amount: 3.34, dueAt: null },
      { id: 93, amount: 6.66, dueAt: null },
    ]);
    expect(
      prepareCounter(
        current,
        'cash',
        { ...draft, milestones: [...draft.milestones].reverse() },
        minimum,
      ).error,
    ).toMatch(/mesmos marcos/);
    expect(
      prepareCounter(
        current,
        'cash',
        {
          ...draft,
          milestones: [{ ...draft.milestones[0]!, title: 'Novo' }, draft.milestones[1]!],
        },
        minimum,
      ).body,
    ).toBeNull();
    expect(prepareCounter(current, 'cash', { ...draft, price: '10.01' }, minimum).error).toMatch(
      /soma/,
    );
  });
  it('prazos dos marcos ordenados, limitados ao prazo de entrega, com datas opcionais', () => {
    const current = offer({
      milestones: [
        { id: 1, title: 'Primeiro', amount: 40, freelancerNet: 34, dueAt: null },
        { id: 2, title: 'Segundo', amount: 60, freelancerNet: 51, dueAt: null },
      ],
    });
    const draft = offerDraft(current);
    draft.message = 'Novos prazos';
    draft.milestones[0]!.due = '2026-10-12';
    draft.milestones[1]!.due = '2026-10-11';
    expect(prepareCounter(current, 'cash', draft, minimum).error).toMatch(/ordem/);
    draft.milestones[1]!.due = '2026-10-15';
    expect(prepareCounter(current, 'cash', draft, minimum).body).toBeNull();
    draft.milestones[1]!.due = '';
    expect(prepareCounter(current, 'cash', draft, minimum).body?.milestones?.[0]?.dueAt).toBe(
      '2026-10-13T03:59:59.000Z',
    );
  });
  it('diferença da reserva conserva os centavos sem ruído binário', () => {
    expect(reserveDelta(10.01, 10.02)).toBe(0.01);
    expect(reserveDelta(150, 120)).toBe(-30);
    expect(reserveDelta(150, 150)).toBe(0);
  });
});
