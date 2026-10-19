import { describe, expect, it } from 'vitest';
import {
  counterOfferHistoryNote,
  counterOfferNotice,
  negotiationCancelledNotice,
  offerAcceptedHistoryNote,
  offerAcceptedNotice,
  offerExpiredNotices,
  offerRejectedNotice,
  proposalNotice,
} from './offer-notices';

const base = { contractId: 7, title: 'Logo nova' };
const terms = {
  ...base,
  mode: 'cash' as const,
  price: 650,
  net: 552.5,
  deadline: 'seg, 19/10/2026, até 23:59',
};
const counter = {
  ...terms,
  heldPrice: 500,
  respondBy: 'qui, 08/10 às 16:40',
  milestoneCount: 2,
  message: 'Incluí a ilustração.',
};
const expiry = {
  ...base,
  cash: true,
  untilClient: 'qui, 08/10 às 16:40',
  untilFreelancer: 'qui, 08/10 às 14:40 (Rio Branco)',
};

describe('avisos da negociação RN-030 (ADR 61 E.2)', () => {
  it('oferta1 apresenta as três ações e datas já formatadas', () => {
    expect(
      proposalNotice({ ...base, deadline: terms.deadline, respondBy: counter.respondBy }),
    ).toEqual({
      params: {
        type: 'contract_proposal',
        title: 'Nova proposta de contratação',
        body: 'Logo nova. Prazo de entrega: seg, 19/10/2026, até 23:59. Responda até qui, 08/10 às 16:40: aceite, recuse ou faça uma contraproposta.',
        data: { contractId: 7 },
      },
    });
    expect(
      proposalNotice({ ...base, deadline: null, respondBy: counter.respondBy }).params.body,
    ).toBe(
      'Logo nova. Responda até qui, 08/10 às 16:40: aceite, recuse ou faça uma contraproposta.',
    );
  });

  it.each([2, 4])(
    'oferta%s ao cliente: valor novo, reserva anterior, marcos e consequência em dinheiro',
    (seq) => {
      expect(counterOfferNotice({ ...counter, seq })).toEqual({
        params: {
          type: 'contract_counter_offer',
          title: 'Contraproposta: Logo nova',
          body: 'Responda até qui, 08/10 às 16:40: o freelancer propõe R$ 650,00, entrega seg, 19/10/2026, até 23:59 (2 marcos). A sua proposta era R$ 500,00. Sem resposta, a negociação se encerra e a reserva volta para você. Mensagem: Incluí a ilustração.',
          data: { contractId: 7 },
        },
      });
    },
  );

  it.each([2, 4])(
    'oferta%s em créditos sem prazo/marcos: não promete uma reserva financeira',
    (seq) => {
      expect(
        counterOfferNotice({
          ...counter,
          seq,
          mode: 'credits',
          price: 12,
          heldPrice: 10,
          deadline: null,
          milestoneCount: 0,
        }).params.body,
      ).toBe(
        'Responda até qui, 08/10 às 16:40: o freelancer propõe 12 créditos. A sua proposta era 10 créditos. Sem resposta, a negociação se encerra. Mensagem: Incluí a ilustração.',
      );
    },
  );

  it.each([
    [3, 'Aceite, recuse ou faça uma contraproposta.'],
    [5, 'É a última rodada: aceite ou recuse.'],
  ])('oferta%s do cliente: líquido em dinheiro e ações da rodada', (seq, actions) => {
    const result = counterOfferNotice({ ...counter, seq: Number(seq) });
    expect(result.params.title).toBe('Contraproposta do cliente: Logo nova');
    expect(result.params.body).toBe(
      `Responda até qui, 08/10 às 16:40: R$ 650,00 (você recebe R$ 552,50), entrega seg, 19/10/2026, até 23:59. ${actions} Mensagem: Incluí a ilustração.`,
    );
  });

  it.each([
    [3, 'Aceite, recuse ou faça uma contraproposta.'],
    [5, 'É a última rodada: aceite ou recuse.'],
  ])(
    'oferta%s do cliente em créditos, sem prazo: não menciona líquido em reais',
    (seq, actions) => {
      expect(
        counterOfferNotice({
          ...counter,
          seq: Number(seq),
          mode: 'credits',
          price: 12,
          deadline: null,
        }).params.body,
      ).toBe(
        `Responda até qui, 08/10 às 16:40: 12 créditos. ${actions} Mensagem: Incluí a ilustração.`,
      );
    },
  );

  it('aceite da oferta1 conserva título anterior e corpo vazio', () => {
    expect(offerAcceptedNotice({ ...terms, seq: 1 })).toEqual({
      params: {
        type: 'contract_accepted',
        title: 'Sua proposta foi aceita',
        body: null,
        data: { contractId: 7 },
      },
    });
  });

  it.each([2, 4])(
    'cliente aceita oferta%s: informa a garantia e o líquido ao freelancer',
    (seq) => {
      expect(offerAcceptedNotice({ ...terms, seq }).params).toMatchObject({
        type: 'contract_accepted',
        title: 'Sua contraproposta foi aceita: Logo nova',
        body: 'R$ 650,00, entrega seg, 19/10/2026, até 23:59. O valor está em garantia: R$ 552,50 para você na aprovação da entrega.',
      });
      expect(
        offerAcceptedNotice({ ...terms, seq, mode: 'credits', price: 12, deadline: null }).params
          .body,
      ).toBe('12 créditos. Os créditos ficam em garantia e são liberados na aprovação da entrega.');
    },
  );

  it.each([3, 5])(
    'freelancer aceita oferta%s: reserva vira garantia, em dinheiro ou créditos',
    (seq) => {
      expect(offerAcceptedNotice({ ...terms, seq }).params.body).toBe(
        'R$ 650,00, entrega seg, 19/10/2026, até 23:59. O valor reservado passou a ser a garantia da contratação.',
      );
      expect(
        offerAcceptedNotice({ ...terms, seq, mode: 'credits', price: 12, deadline: null }).params
          .body,
      ).toBe('12 créditos. Os créditos ficam em garantia até a aprovação da entrega.');
    },
  );

  it.each(['cash', 'credits'] as const)(
    'recusa da proposta1 em %s: preserva nome e só devolve dinheiro quando reservado',
    (mode) => {
      expect(offerRejectedNotice({ ...base, seq: 1, mode, heldPrice: 500 }).params).toEqual({
        type: 'contract_rejected',
        title: 'Sua proposta foi recusada',
        body: mode === 'cash' ? 'Logo nova. R$ 500,00 voltou para a sua carteira.' : 'Logo nova.',
        data: { contractId: 7 },
      });
    },
  );

  it.each([2, 3, 4, 5])(
    'saída do freelancer na oferta%s: devolve o valor reservado do cliente',
    (seq) => {
      expect(
        offerRejectedNotice({ ...base, seq, mode: 'cash', heldPrice: 500 }).params,
      ).toMatchObject({
        title:
          seq % 2
            ? 'Sua contraproposta foi recusada: Logo nova'
            : 'O freelancer encerrou a negociação: Logo nova',
        body: 'R$ 500,00 voltou para a sua carteira. Se quiser, envie uma nova proposta.',
      });
      expect(
        offerRejectedNotice({ ...base, seq, mode: 'credits', heldPrice: 10 }).params.body,
      ).toBe('Se quiser, envie uma nova proposta.');
    },
  );

  it('cancelamento do cliente durante negociação informa encerramento antes do aceite', () => {
    expect(negotiationCancelledNotice(base)).toEqual({
      params: {
        type: 'contract_cancelled',
        title: 'Negociação encerrada pelo cliente: Logo nova',
        body: 'O cliente encerrou a negociação antes do aceite.',
        data: { contractId: 7 },
      },
    });
  });

  it.each([true, false])('expiração1 conserva o texto anterior, cash=%s', (cash) => {
    const result = offerExpiredNotices({ ...expiry, seq: 1, cash });
    expect(result.client.params.title).toBe('Sua proposta expirou sem resposta');
    expect(result.client.params.body).toBe(
      `Logo nova: o freelancer não respondeu até qui, 08/10 às 16:40.${cash ? ' O valor reservado voltou para a sua carteira.' : ''}`,
    );
    expect(result.freelancer.params.title).toBe('Uma proposta expirou');
    expect(result.freelancer.params.body).toBe(
      'Logo nova: sem resposta até qui, 08/10 às 14:40 (Rio Branco), a proposta foi encerrada.',
    );
  });

  it.each([2, 3, 4, 5])(
    'expiração%s descreve quem não respondeu, e a hora de cada leitor',
    (seq) => {
      const result = offerExpiredNotices({ ...expiry, seq });
      expect(result.client.params.title).toBe(
        seq % 2
          ? 'Sua contraproposta expirou sem resposta'
          : 'A contraproposta expirou sem resposta',
      );
      expect(result.client.params.body).toBe(
        `Logo nova: ${seq % 2 ? 'o freelancer' : 'você'} não respondeu até qui, 08/10 às 16:40. O valor reservado voltou para a sua carteira. Se quiser, envie uma nova proposta.`,
      );
      expect(result.freelancer.params.title).toBe(
        seq % 2 ? 'Uma contraproposta expirou' : 'Sua contraproposta expirou',
      );
      expect(result.freelancer.params.body).toBe(
        `Logo nova: ${seq % 2 ? 'sem a sua resposta' : 'sem resposta do cliente'} até qui, 08/10 às 14:40 (Rio Branco), a negociação foi encerrada.`,
      );
      expect(offerExpiredNotices({ ...expiry, seq, cash: false }).client.params.body).not.toContain(
        'reservado',
      );
    },
  );

  it('avisos esperam o silêncio e abrem o corpo com uma frase que cabe no resumo de120 caracteres', () => {
    const notices = [
      proposalNotice({ ...base, deadline: null, respondBy: counter.respondBy }),
      negotiationCancelledNotice(base),
    ];
    for (const seq of [2, 3, 4, 5]) {
      notices.push(
        counterOfferNotice({ ...counter, seq }),
        offerAcceptedNotice({ ...terms, seq }),
        offerRejectedNotice({ ...base, seq, mode: 'cash', heldPrice: 500 }),
      );
      const expired = offerExpiredNotices({ ...expiry, seq });
      notices.push(expired.client, expired.freelancer);
    }
    for (const item of notices) {
      expect(item.passCategory).toBeUndefined();
      expect(item.params.data).toEqual({ contractId: 7 });
      expect(item.params.body!.split('. ')[0]!.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('notas da negociação na linha do tempo (RN-022, ADR 61 E.2/D.3)', () => {
  const day = 'seg, 19/10/2026, até 23:59 (horário de Brasília)';
  const history = {
    mode: 'cash' as const,
    price: 650,
    deadline: day,
    message: 'Incluí a ilustração.',
  };

  it.each([
    { seq: 2, by: 'freelancer' as const, author: 'freelancer', round: 1 },
    { seq: 3, by: 'client' as const, author: 'cliente', round: 2 },
    { seq: 4, by: 'freelancer' as const, author: 'freelancer', round: 2 },
    { seq: 5, by: 'client' as const, author: 'cliente', round: 3 },
  ])('oferta $seq conserva autor, rodada, preço e data explícita', ({ seq, by, author, round }) => {
    expect(counterOfferHistoryNote({ ...history, seq, by })).toBe(
      `Contraproposta do ${author} (rodada ${round} de 3): R$ 650,00, entrega ${day}. Mensagem: Incluí a ilustração.`,
    );
  });

  it('créditos sem prazo nem marcos não ganham termos financeiros ou datas inventadas', () => {
    expect(
      counterOfferHistoryNote({
        ...history,
        seq: 3,
        by: 'client',
        mode: 'credits',
        price: 12,
        deadline: null,
        milestones: [],
      }),
    ).toBe(
      'Contraproposta do cliente (rodada 2 de 3): 12 créditos. Mensagem: Incluí a ilustração.',
    );
  });

  it('lista os marcos na ordem recebida, com título, valor e só as datas conhecidas', () => {
    const facts = {
      ...history,
      seq: 2,
      by: 'freelancer' as const,
      milestones: [
        { title: 'Esboço', amount: 300, due: 'qua, 14/10 (horário de Brasília)' },
        { title: 'Arte final', amount: 350, due: null },
      ],
    };
    const before = JSON.stringify(facts);
    expect(counterOfferHistoryNote(facts)).toBe(
      `Contraproposta do freelancer (rodada 1 de 3): R$ 650,00, entrega ${day}; marcos: «Esboço» R$ 300,00 até qua, 14/10 (horário de Brasília); «Arte final» R$ 350,00. Mensagem: Incluí a ilustração.`,
    );
    expect(JSON.stringify(facts)).toBe(before);
    expect(
      counterOfferHistoryNote({
        ...facts,
        mode: 'credits',
        price: 12,
        deadline: null,
        milestones: [
          { title: 'Esboço', amount: 5, due: null },
          { title: 'Arte final', amount: 7, due: null },
        ],
      }),
    ).toBe(
      'Contraproposta do freelancer (rodada 1 de 3): 12 créditos; marcos: «Esboço» 5 créditos; «Arte final» 7 créditos. Mensagem: Incluí a ilustração.',
    );
  });

  it.each(['cash', 'credits'] as const)('aceite inicial em %s preserva a nota null', (mode) => {
    expect(offerAcceptedHistoryNote({ ...history, seq: 1, by: 'client', mode })).toBeNull();
  });

  it.each([2, 4])('cliente aceita oferta %s do freelancer: termos e quem aceitou', (seq) => {
    expect(offerAcceptedHistoryNote({ ...history, seq, by: 'freelancer' })).toBe(
      `Contraproposta ${seq} do freelancer aceita pelo cliente: R$ 650,00, entrega ${day}`,
    );
    expect(
      offerAcceptedHistoryNote({
        ...history,
        seq,
        by: 'freelancer',
        mode: 'credits',
        price: 12,
        deadline: null,
      }),
    ).toBe(`Contraproposta ${seq} do freelancer aceita pelo cliente: 12 créditos`);
  });

  it.each([3, 5])('freelancer aceita oferta %s do cliente: valor e data aceitos', (seq) => {
    expect(offerAcceptedHistoryNote({ ...history, seq, by: 'client' })).toBe(
      `Contraproposta ${seq} do cliente aceita: R$ 650,00, entrega ${day}`,
    );
    expect(
      offerAcceptedHistoryNote({
        ...history,
        seq,
        by: 'client',
        mode: 'credits',
        price: 12,
        deadline: null,
      }),
    ).toBe(`Contraproposta ${seq} do cliente aceita: 12 créditos`);
  });
});
