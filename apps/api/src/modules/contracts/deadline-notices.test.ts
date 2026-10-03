import { describe, expect, it } from 'vitest';
import {
  autoDisputeDescription,
  autoDisputeNotice,
  brl,
  cancelledNotice,
  extensionAcceptedNotice,
  extensionDeclinedNotice,
  extensionExpiredClientNotice,
  extensionExpiredFreelancerNotice,
  extensionRequestedNotice,
  milestoneList,
  overdueClientNotice,
  overdueFreelancerNotice,
  revisionNotice,
  type DecisionFacts,
  type OverdueFacts,
} from './deadline-notices';

/**
 * Os avisos do prazo palavra por palavra (ADR 56 e 57): o que dizem, e quem pode receber durante
 * o "não perturbe". A hora-limite e a ação vêm primeiro: o aviso no aparelho corta em 120.
 */
const facts = (o: Partial<OverdueFacts> = {}): OverdueFacts => ({
  contractId: 3,
  title: 'Vídeo institucional',
  deadline: '02/10/2026',
  limit: 'dom, 04/10 às 09:03',
  byMilestones: false,
  missing: [],
  requestsLeft: 2,
  extensionAccepted: false,
  cancelOpen: true,
  delivered: 0,
  total: 0,
  ...o,
});

describe('prazo estourado, cópia de quem entrega (RN-029)', () => {
  it('entrega única, pode pedir: entregar ou pedir; sempre sai no silêncio', () => {
    const n = overdueFreelancerNotice(facts());
    expect(n.passCategory).toBe('deadline');
    expect(n.params).toEqual({
      type: 'contract_overdue',
      title: 'Prazo estourado: Vídeo institucional',
      body: 'Até dom, 04/10 às 09:03: entregue ou peça a extensão, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. O prazo era 02/10/2026.',
      data: { contractId: 3 },
    });
    expect(n.params.body!.slice(0, 120)).toContain('entregue ou peça a extensão');
  });

  it('extensão já aceita uma vez: só a entrega', () => {
    const n = overdueFreelancerNotice(facts({ extensionAccepted: true, requestsLeft: 0 }));
    expect(n.passCategory).toBe('deadline');
    expect(n.params.body).toBe(
      'Até dom, 04/10 às 09:03: registre a entrega, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. A extensão já foi usada. O prazo era 02/10/2026.',
    );
  });

  it('os 2 pedidos recusados: não há mais pedido', () => {
    expect(overdueFreelancerNotice(facts({ requestsLeft: 0 })).params.body).toContain(
      'registre a entrega, senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. Não há mais pedido de extensão.',
    );
  });

  it('por marcos, sempre sai no silêncio: há o que fazer (entregar o marco)', () => {
    const n = overdueFreelancerNotice(
      facts({
        byMilestones: true,
        missing: ['Layout', 'Publicação'],
        requestsLeft: 0,
        extensionAccepted: true,
        total: 2,
      }),
    );
    expect(n.passCategory).toBe('deadline');
    expect(n.params.body).toBe(
      'Até dom, 04/10 às 09:03: entregue os marcos «Layout» e «Publicação», senão a disputa abre sozinha. O cliente já pode cancelar com reembolso integral. A extensão já foi usada. O prazo era 02/10/2026.',
    );
  });

  it('entrega parcial por marcos: o cliente pode cancelar o que falta', () => {
    const n = overdueFreelancerNotice(
      facts({ byMilestones: true, missing: ['Publicação'], delivered: 1, total: 2 }),
    );
    expect(n.params.body).toContain('entregue o marco «Publicação» ou peça a extensão');
    expect(n.params.body).toContain(
      'O cliente já pode cancelar o que falta com reembolso integral.',
    );
  });

  it('com marco entregue em aberto o cancelamento está travado: a frase sai', () => {
    const n = overdueFreelancerNotice(
      facts({ byMilestones: true, missing: ['B'], delivered: 1, total: 2, cancelOpen: false }),
    );
    expect(n.params.body).not.toContain('cancelar');
  });
});

describe('prazo estourado, cópia do cliente', () => {
  it('entrega única: nunca sai no silêncio; oferece o cancelamento com reembolso integral', () => {
    const n = overdueClientNotice(facts());
    expect(n.passCategory).toBeUndefined();
    expect(n.params.body).toBe(
      'Sem entrega nem extensão aceita até dom, 04/10 às 09:03, a disputa abre sozinha. Se preferir, cancele com reembolso integral. O prazo era 02/10/2026 e não houve entrega.',
    );
  });

  it('por marcos, nenhum entregue', () => {
    expect(
      overdueClientNotice(facts({ byMilestones: true, missing: ['A', 'B'], total: 2 })).params.body,
    ).toBe(
      'Sem as entregas que faltam nem extensão aceita até dom, 04/10 às 09:03, a disputa abre sozinha. Se preferir, cancele com reembolso integral. O prazo era 02/10/2026 e nenhum marco foi entregue.',
    );
  });

  it('a hora da disputa cabe nos 120 caracteres do aviso no aparelho', () => {
    for (const f of [
      facts(),
      facts({ byMilestones: true, missing: ['A', 'B'], total: 2 }),
      facts({ byMilestones: true, missing: ['Publicação'], delivered: 1, total: 2 }),
    ]) {
      expect(overdueClientNotice(f).params.body!.slice(0, 120)).toContain('dom, 04/10 às 09:03');
    }
  });

  it('entrega parcial: nunca diz "não houve entrega"', () => {
    const body = overdueClientNotice(
      facts({ byMilestones: true, missing: ['Publicação'], delivered: 1, total: 2 }),
    ).params.body!;
    expect(body).toBe(
      'Sem as entregas que faltam nem extensão aceita até dom, 04/10 às 09:03, a disputa abre sozinha. Se preferir, cancele o que falta com reembolso integral. O prazo era 02/10/2026: 1 de 2 marcos entregues; falta o marco «Publicação».',
    );
    expect(body).not.toContain('não houve entrega');
  });

  it('cancelamento travado: sem a oferta', () => {
    expect(overdueClientNotice(facts({ cancelOpen: false })).params.body).not.toContain('cancele');
  });
});

describe('extensão (RN-028)', () => {
  const decision = (o: Partial<DecisionFacts> = {}): DecisionFacts => ({
    contractId: 3,
    title: 'Vídeo institucional',
    deadline: '02/10/2026',
    byMilestones: false,
    missing: [],
    requestsLeft: 1,
    phase: 'future',
    limit: null,
    noticeAt: null,
    mediationAt: null,
    ...o,
  });

  it('pedido: responder até, com o motivo no fim', () => {
    expect(
      extensionRequestedNotice({
        contractId: 3,
        title: 'Vídeo',
        respondBy: 'qui, 08/10 às 16:40',
        proposed: '20/10/2026',
        reason: 'material atrasou',
      }).params,
    ).toMatchObject({
      type: 'deadline_extension_requested',
      title: 'Pedido de extensão: Vídeo',
      body: 'Responda até qui, 08/10 às 16:40: novo prazo proposto 20/10/2026. Sem resposta, o pedido expira e vale o prazo atual. Motivo: material atrasou',
    });
  });

  it('aceite: o título diz só o dia do novo prazo e o corpo, o prazo inteiro (ADR 58)', () => {
    const n = extensionAcceptedNotice({
      contractId: 3,
      title: 'Vídeo',
      day: 'qua, 07/10',
      deadline: 'qua, 07/10/2026, até 23:59 (horário de Manaus)',
    });
    expect(n.passCategory).toBeUndefined();
    expect(n.params).toEqual({
      type: 'deadline_extension_accepted',
      title: 'Extensão aceita: novo prazo qua, 07/10',
      body: 'Vídeo: o novo prazo é qua, 07/10/2026, até 23:59 (horário de Manaus); não há outra extensão nesta contratação.',
      data: { contractId: 3 },
    });
  });

  it('recusa com o prazo no futuro: vale o prazo atual; sobra um pedido', () => {
    const n = extensionDeclinedNotice(decision());
    expect(n.passCategory).toBeUndefined();
    expect(n.params).toMatchObject({
      title: 'Extensão de prazo recusada',
      body: 'Vídeo institucional: vale o prazo atual, 02/10/2026. Você ainda pode fazer mais um pedido.',
    });
  });

  it('recusa com a carência correndo: até quando, sem furar o silêncio (sobram 6 h de dia)', () => {
    const n = extensionDeclinedNotice(
      decision({ phase: 'grace', limit: 'dom, 04/10 às 14:59', requestsLeft: 0 }),
    );
    expect(n.passCategory).toBeUndefined();
    expect(n.params).toMatchObject({
      title: 'Extensão recusada: Vídeo institucional',
      body: 'Prazo vencido. Até dom, 04/10 às 14:59: registre a entrega, senão a disputa abre sozinha. O prazo era 02/10/2026. Não há mais pedido de extensão.',
    });
  });

  it('recusa com o prazo vencido e o aviso ainda por sair: nada de "vale o prazo atual" com data passada', () => {
    const body = extensionDeclinedNotice(
      decision({
        phase: 'due',
        noticeAt: 'sáb, 03/10 às 09:00',
        mediationAt: 'dom, 04/10 às 09:00',
      }),
    ).params.body!;
    expect(body).toBe(
      'Sem entrega nem extensão aceita, a disputa abre a partir de dom, 04/10 às 09:00; o aviso de atraso sai a partir de sáb, 03/10 às 09:00. O prazo era 02/10/2026. Você ainda pode fazer mais um pedido.',
    );
    expect(body).not.toContain('vale o prazo atual');
  });

  it('expirado: as duas cópias, sem categoria', () => {
    const mine = extensionExpiredFreelancerNotice({
      ...decision({ phase: 'grace', limit: 'ter, 06/10 às 14:30', requestsLeft: 0 }),
      respondBy: 'seg, 05/10 às 20:00',
    });
    expect(mine.passCategory).toBeUndefined();
    expect(mine.params).toMatchObject({
      type: 'deadline_extension_expired',
      title: 'Pedido de extensão sem resposta: Vídeo institucional',
      body: 'Até ter, 06/10 às 14:30: registre a entrega, senão a disputa abre sozinha. O prazo era 02/10/2026. O cliente não respondeu até seg, 05/10 às 20:00. Não há mais pedido de extensão.',
    });
    expect(
      extensionExpiredClientNotice({
        contractId: 3,
        title: 'Vídeo',
        respondBy: 'seg, 05/10 às 20:00',
        proposed: 'sáb, 10/10/2026, até 23:59',
        deadline: 'sex, 02/10/2026, até 23:59',
      }).params.body,
    ).toBe(
      'Sem a sua resposta até seg, 05/10 às 20:00, o pedido de novo prazo, sáb, 10/10/2026, até 23:59, expirou e vale o prazo atual, sex, 02/10/2026, até 23:59.',
    );
  });
});

describe('revisão, cancelamento e disputa', () => {
  it('revisão da entrega única: aviso simples, sem categoria nem hora-limite', () => {
    const n = revisionNotice({ contractId: 3, title: 'Vídeo', note: 'trocar a trilha' });
    expect(n.passCategory).toBeUndefined();
    expect(n.params).toEqual({
      type: 'contract_revision',
      title: 'Revisão pedida: Vídeo',
      body: 'trocar a trilha',
      data: { contractId: 3 },
    });
  });

  it('cancelamento: o texto de cada etapa para a outra parte', () => {
    const base = { contractId: 3, title: 'Vídeo', unit: 'BRL' as const };
    const body = (o: Parameters<typeof cancelledNotice>[0]) => cancelledNotice(o).params;
    expect(
      body({ ...base, by: 'client', stage: 'overdue', refundClient: 200, releaseFreelancer: 0 }),
    ).toMatchObject({
      title: 'Contratação cancelada pelo cliente: Vídeo',
      body: 'O prazo tinha vencido sem entrega: R$ 200,00 voltou ao cliente.',
    });
    expect(
      body({ ...base, by: 'client', stage: 'early', refundClient: 100, releaseFreelancer: 85 })
        .body,
    ).toBe(
      'R$ 85,00 foi liberado na sua carteira e R$ 100,00 voltou ao cliente (reembolso de 50%).',
    );
    expect(
      body({ ...base, by: 'client', stage: 'late', refundClient: 0, releaseFreelancer: 170 }).body,
    ).toBe(
      'R$ 170,00 foi liberado na sua carteira: mais da metade do tempo até o prazo já tinha passado.',
    );
    expect(
      body({ ...base, by: 'client', stage: 'proposal', refundClient: 200, releaseFreelancer: 0 }),
    ).toMatchObject({ title: 'Proposta retirada: Vídeo' });
    expect(
      body({
        ...base,
        by: 'freelancer',
        stage: 'withdrawal',
        refundClient: 1234.5,
        releaseFreelancer: 0,
      }),
    ).toMatchObject({
      title: 'O freelancer desistiu: Vídeo',
      body: 'R$ 1.234,50 voltou para a sua carteira.',
    });
    expect(
      body({
        ...base,
        unit: 'credits',
        by: 'freelancer',
        stage: 'withdrawal',
        refundClient: 30,
        releaseFreelancer: 0,
      }).body,
    ).toBe('Os 30 créditos voltaram para a sua carteira.');
    expect(
      cancelledNotice({
        ...base,
        by: 'client',
        stage: 'early',
        refundClient: 1,
        releaseFreelancer: 1,
      }).params.type,
    ).toBe('contract_cancelled');
  });

  it('com marco entregue, a disputa, o aviso dela e o cancelamento nunca dizem "sem entrega"', () => {
    const d = autoDisputeDescription({
      deadline: '02/10/2026',
      noticeAt: '03/10/2026 às 09:03',
      limit: '04/10/2026 às 09:03',
      delivered: ['Layout'],
      missing: ['Publicação'],
    });
    expect(d).toContain('venceu com marcos nunca entregues');
    expect(d).not.toContain('venceu sem entrega');
    expect(d).not.toContain('não houve entrega');
    const n = autoDisputeNotice({
      contractId: 1,
      disputeId: 2,
      title: 'Site',
      limit: 'x',
      partial: true,
    });
    expect(n.params.body).toBe(
      'Site: sem os marcos que faltavam nem extensão aceita até x, a disputa abriu e a mediação do Escambo decide sobre o valor.',
    );
    const c = cancelledNotice({
      contractId: 1,
      title: 'Site',
      by: 'client',
      stage: 'overdue',
      unit: 'BRL',
      refundClient: 200,
      releaseFreelancer: 0,
      partial: true,
    });
    expect(c.params.body).toBe(
      'O prazo tinha vencido com marcos nunca entregues: R$ 200,00, o que faltava, voltou ao cliente.',
    );
  });

  it('descrição da disputa automática: começa por "Aberta automaticamente", diz o prazo como dia e lista os marcos', () => {
    const d = autoDisputeDescription({
      deadline: 'sex, 02/10/2026, até 23:59 (horário de Brasília)',
      noticeAt: '03/10/2026 às 09:03',
      limit: '04/10/2026 às 09:03',
      delivered: ['Layout'],
      missing: ['Publicação'],
    });
    expect(d).toBe(
      'Aberta automaticamente pela plataforma (RN-029): o prazo de entrega, sex, 02/10/2026, até 23:59 (horário de Brasília), venceu com marcos nunca entregues, o aviso saiu em 03/10/2026 às 09:03 e, até 04/10/2026 às 09:03, eles não foram entregues nem houve extensão aceita. O aviso e o limite estão em horário de Brasília. Marcos entregues: «Layout»; sem entrega: «Publicação».',
    );
  });

  it('descrição da disputa automática da entrega única: "venceu sem entrega", sem lista de marcos', () => {
    expect(
      autoDisputeDescription({
        deadline: 'sex, 02/10/2026, até 23:59 (horário de Manaus)',
        noticeAt: '03/10/2026 às 10:03',
        limit: '04/10/2026 às 10:03',
        delivered: null,
        missing: null,
      }),
    ).toBe(
      'Aberta automaticamente pela plataforma (RN-029): o prazo de entrega, sex, 02/10/2026, até 23:59 (horário de Manaus), venceu sem entrega, o aviso saiu em 03/10/2026 às 10:03 e, até 04/10/2026 às 10:03, não houve entrega nem extensão aceita. O aviso e o limite estão em horário de Brasília.',
    );
  });

  it('milestoneList e brl', () => {
    expect(milestoneList(['A'])).toBe('o marco «A»');
    expect(milestoneList(['A', 'B', 'C'])).toBe('os marcos «A», «B» e «C»');
    expect(milestoneList(['A', 'B', 'C', 'D'])).toBe('4 marcos');
    expect(brl(0.5)).toBe('R$ 0,50');
  });
});
