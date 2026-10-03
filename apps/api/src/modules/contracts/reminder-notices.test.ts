import { describe, expect, it } from 'vitest';
import type { DeadlineNotice } from './deadline-notices';
import {
  approvalReminder,
  deliveryReminder,
  extensionReminder,
  milestoneApprovalReminder,
  proposalReminder,
  revisionStalledNotices,
  type MilestoneDue,
} from './reminder-notices';

/**
 * Os lembretes antes de cada vencimento e o aviso de revisão parada (ADR 58), palavra por palavra.
 * O título é o vencimento: a ação e a hora (ou o dia) vêm antes do nome da contratação, porque o
 * título é cortado em 150 caracteres e o resumo do "não perturbe" só mostra títulos.
 */

describe('proposalReminder: o freelancer responde à proposta antes de ela se encerrar (RN-021)', () => {
  it('em dinheiro e com prazo: diz que a reserva volta ao cliente e qual é o prazo se aceitar', () => {
    expect(
      proposalReminder({
        contractId: 3,
        title: 'Vídeo institucional',
        respondBy: 'qui, 08/10 às 12:00',
        cash: true,
        deadline: 'ter, 20/10/2026, até 23:59',
      }),
    ).toEqual({
      params: {
        type: 'contract_proposal_reminder',
        title: 'Responda à proposta até qui, 08/10 às 12:00: Vídeo institucional',
        body: 'Aceite ou recuse até lá. Sem resposta, a proposta se encerra e o valor reservado volta ao cliente. Se aceitar, o prazo de entrega é ter, 20/10/2026, até 23:59.',
        data: { contractId: 3 },
      },
    });
  });

  it('sem dinheiro reservado e sem prazo: nem fala em reserva nem em prazo', () => {
    expect(
      proposalReminder({
        contractId: 3,
        title: 'Vídeo institucional',
        respondBy: 'qui, 08/10 às 12:00',
        cash: false,
        deadline: null,
      }).params.body,
    ).toBe('Aceite ou recuse até lá. Sem resposta, a proposta se encerra.');
  });
});

describe('deliveryReminder: quem entrega, antes do prazo de entrega (RN-029)', () => {
  const base = {
    contractId: 3,
    title: 'Vídeo institucional',
    day: 'sex, 09/10',
    deadline: 'sex, 09/10/2026, até 23:59',
    byMilestones: false,
    missing: [] as string[],
    canRequest: true,
    cancelOpen: true,
    partial: false,
    noticeAt: 'sáb, 10/10 às 09:00',
    graceHours: 24,
  };

  it('entrega única, ainda dá para pedir extensão e o cliente poderá cancelar: diz tudo, com o prazo inteiro no fim', () => {
    expect(deliveryReminder(base)).toEqual({
      params: {
        type: 'contract_deadline_reminder',
        title: 'Entregue até sex, 09/10: Vídeo institucional',
        body: 'Registre a entrega até lá ou peça a extensão antes. Sem entrega, a partir de sáb, 10/10 às 09:00 o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é sex, 09/10/2026, até 23:59.',
        data: { contractId: 3 },
      },
    });
  });

  it('entrega única sem extensão possível nem cancelamento aberto, com carência de 1 hora', () => {
    expect(
      deliveryReminder({ ...base, canRequest: false, cancelOpen: false, graceHours: 1 }).params
        .body,
    ).toBe(
      'Registre a entrega até lá: não há mais pedido de extensão. Sem entrega, a partir de sáb, 10/10 às 09:00 o Escambo avisa vocês dois e começa a carência até a disputa automática (hoje, 1 hora). O prazo é sex, 09/10/2026, até 23:59.',
    );
  });

  it('entrega única: "o que falta" é só de marcos, mesmo que venha marcado como parcial', () => {
    expect(deliveryReminder({ ...base, partial: true }).params.body).toBe(
      'Registre a entrega até lá ou peça a extensão antes. Sem entrega, a partir de sáb, 10/10 às 09:00 o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é sex, 09/10/2026, até 23:59.',
    );
  });

  it('por marcos, nenhum entregue: lista os que faltam e o cancelamento é do todo', () => {
    expect(
      deliveryReminder({ ...base, byMilestones: true, missing: ['Layout', 'Publicação'] }).params
        .body,
    ).toBe(
      'Entregue os marcos «Layout» e «Publicação» até lá ou peça a extensão antes. Sem as entregas, a partir de sáb, 10/10 às 09:00 o Escambo avisa vocês dois, o cliente pode cancelar com reembolso integral e começa a carência até a disputa automática (hoje, 24 horas). O prazo é sex, 09/10/2026, até 23:59.',
    );
  });

  it('por marcos, com algum já entregue e sem extensão possível: o cancelamento é do que falta', () => {
    expect(
      deliveryReminder({
        ...base,
        byMilestones: true,
        missing: ['Publicação'],
        partial: true,
        canRequest: false,
        graceHours: 48,
      }).params.body,
    ).toBe(
      'Entregue o marco «Publicação» até lá: não há mais pedido de extensão. Sem as entregas, a partir de sáb, 10/10 às 09:00 o Escambo avisa vocês dois, o cliente pode cancelar o que falta com reembolso integral e começa a carência até a disputa automática (hoje, 48 horas). O prazo é sex, 09/10/2026, até 23:59.',
    );
  });

  it('por marcos com marco entregue em aberto: nenhuma oferta de cancelamento', () => {
    expect(
      deliveryReminder({
        ...base,
        byMilestones: true,
        missing: ['Publicação'],
        partial: true,
        cancelOpen: false,
      }).params.body,
    ).toBe(
      'Entregue o marco «Publicação» até lá ou peça a extensão antes. Sem as entregas, a partir de sáb, 10/10 às 09:00 o Escambo avisa vocês dois e começa a carência até a disputa automática (hoje, 24 horas). O prazo é sex, 09/10/2026, até 23:59.',
    );
  });
});

describe('approvalReminder: o cliente, antes da aprovação automática da entrega (RN-024)', () => {
  const base = {
    contractId: 3,
    title: 'Vídeo institucional',
    until: 'dom, 11/10 às 18:20',
    price: 900,
    credits: 0,
  };

  it('em dinheiro: o pagamento é liberado sozinho; diz o valor da contratação', () => {
    expect(approvalReminder({ ...base, mode: 'cash' })).toEqual({
      params: {
        type: 'contract_approval_reminder',
        title: 'Aprove ou peça revisão até dom, 11/10 às 18:20: Vídeo institucional',
        body: 'Depois disso, a entrega é aprovada sozinha, o pagamento é liberado ao freelancer e não cabe mais revisão nem disputa. Valor da contratação: R$ 900,00.',
        data: { contractId: 3 },
      },
    });
  });

  it('em créditos: os créditos é que são liberados, e o número dito é o dos créditos, não o do preço', () => {
    expect(approvalReminder({ ...base, mode: 'credits', price: 45, credits: 40 }).params.body).toBe(
      'Depois disso, a entrega é aprovada sozinha, os créditos são liberados ao freelancer e não cabe mais revisão nem disputa. Créditos da contratação: 40.',
    );
  });

  it('na troca: não há valor, a entrega conta para fechar a troca', () => {
    expect(approvalReminder({ ...base, mode: 'barter', price: 0 }).params.body).toBe(
      'Depois disso, a entrega é aprovada sozinha, conta para fechar a troca e não cabe mais revisão nem disputa.',
    );
  });
});

describe('milestoneApprovalReminder: o cliente, antes da aprovação automática dos marcos (RN-069)', () => {
  const sun = new Date('2026-10-11T21:20:00Z');
  const mon = new Date('2026-10-12T12:00:00Z');
  const layout: MilestoneDue = {
    id: 5,
    title: 'Layout',
    amount: 333.33,
    until: 'dom, 11/10 às 18:20',
    dueAt: sun,
  };
  const front: MilestoneDue = {
    id: 6,
    title: 'Front',
    amount: 666.67,
    until: 'seg, 12/10 às 09:00',
    dueAt: mon,
  };
  const base = { contractId: 31, title: 'Site em 3 etapas', mode: 'cash' as const };

  it('um marco: a hora e a ação primeiro, o marco no título e a contratação no fim do corpo', () => {
    expect(milestoneApprovalReminder({ ...base, milestones: [layout] })).toEqual({
      params: {
        type: 'contract_approval_reminder',
        title: 'Até dom, 11/10 às 18:20: aprove ou peça revisão do marco «Layout»',
        body: 'Depois disso, o marco é aprovado sozinho, o pagamento dele é liberado ao freelancer e não cabe mais pedir revisão. Valor do marco: R$ 333,33. Contratação: Site em 3 etapas.',
        data: { contractId: 31, milestoneId: 5 },
      },
    });
  });

  it('um marco em créditos: o valor é em créditos', () => {
    expect(
      milestoneApprovalReminder({
        ...base,
        mode: 'credits',
        milestones: [{ ...layout, amount: 20 }],
      }).params.body,
    ).toBe(
      'Depois disso, o marco é aprovado sozinho, os créditos dele são liberados ao freelancer e não cabe mais pedir revisão. Valor do marco: 20 créditos. Contratação: Site em 3 etapas.',
    );
  });

  it('um marco de 1 crédito: o valor vem no singular', () => {
    expect(
      milestoneApprovalReminder({
        ...base,
        mode: 'credits',
        milestones: [{ ...layout, amount: 1 }],
      }).params.body,
    ).toBe(
      'Depois disso, o marco é aprovado sozinho, os créditos dele são liberados ao freelancer e não cabe mais pedir revisão. Valor do marco: 1 crédito. Contratação: Site em 3 etapas.',
    );
  });

  it('um marco de 2 créditos: o valor vem no plural', () => {
    expect(
      milestoneApprovalReminder({
        ...base,
        mode: 'credits',
        milestones: [{ ...layout, amount: 2 }],
      }).params.body,
    ).toBe(
      'Depois disso, o marco é aprovado sozinho, os créditos dele são liberados ao freelancer e não cabe mais pedir revisão. Valor do marco: 2 créditos. Contratação: Site em 3 etapas.',
    );
  });

  it('um marco de R$ 1,00 em dinheiro: o singular de crédito não vale para reais', () => {
    expect(
      milestoneApprovalReminder({ ...base, milestones: [{ ...layout, amount: 1 }] }).params.body,
    ).toBe(
      'Depois disso, o marco é aprovado sozinho, o pagamento dele é liberado ao freelancer e não cabe mais pedir revisão. Valor do marco: R$ 1,00. Contratação: Site em 3 etapas.',
    );
  });

  it('vários marcos com a mesma hora: um lembrete só, com a hora em comum, a lista e a soma', () => {
    expect(
      milestoneApprovalReminder({ ...base, milestones: [layout, { ...front, dueAt: sun }] }),
    ).toEqual({
      params: {
        type: 'contract_approval_reminder',
        title: 'Aprove ou peça revisão de 2 marcos até dom, 11/10 às 18:20: Site em 3 etapas',
        body: 'Depois disso, os marcos «Layout» e «Front» são aprovados sozinhos, o pagamento deles é liberado ao freelancer e não cabe mais pedir revisão. Valor dos marcos: R$ 1.000,00.',
        data: { contractId: 31 },
      },
    });
  });

  it('vários marcos com horas diferentes: o título diz a primeira hora, na ordem de vencimento, sem mexer na lista de quem chamou', () => {
    const milestones = [front, layout];
    expect(milestoneApprovalReminder({ ...base, milestones })).toEqual({
      params: {
        type: 'contract_approval_reminder',
        title:
          '2 marcos esperam a sua resposta, o primeiro até dom, 11/10 às 18:20: Site em 3 etapas',
        body: 'Cada um é aprovado sozinho na hora dele (a de cada marco está na Sala): os marcos «Layout» e «Front». O pagamento é liberado ao freelancer e não cabe mais pedir revisão. Valor dos marcos: R$ 1.000,00.',
        data: { contractId: 31 },
      },
    });
    expect(milestones.map((m) => m.id)).toEqual([6, 5]);
  });

  it('vários marcos em créditos: a soma é em créditos', () => {
    expect(
      milestoneApprovalReminder({
        ...base,
        mode: 'credits',
        milestones: [
          { ...layout, amount: 20 },
          { ...front, amount: 20, dueAt: sun },
        ],
      }).params.body,
    ).toBe(
      'Depois disso, os marcos «Layout» e «Front» são aprovados sozinhos, os créditos deles são liberados ao freelancer e não cabe mais pedir revisão. Valor dos marcos: 40 créditos.',
    );
  });

  it('vários marcos de 1 crédito cada: a soma de 2 vem no plural', () => {
    expect(
      milestoneApprovalReminder({
        ...base,
        mode: 'credits',
        milestones: [
          { ...layout, amount: 1 },
          { ...front, amount: 1 },
        ],
      }).params.body,
    ).toBe(
      'Cada um é aprovado sozinho na hora dele (a de cada marco está na Sala): os marcos «Layout» e «Front». Os créditos são liberados ao freelancer e não cabe mais pedir revisão. Valor dos marcos: 2 créditos.',
    );
  });
});

describe('extensionReminder: o cliente responde ao pedido de extensão antes de ele expirar (RN-028)', () => {
  const base = {
    contractId: 3,
    title: 'Vídeo institucional',
    until: 'qui, 08/10 às 12:00',
    proposed: 'sex, 16/10/2026, até 23:59',
    deadline: 'sex, 09/10/2026, até 23:59',
  };

  it('com o prazo atual ainda correndo: sem resposta, vale o prazo atual, dito como dia', () => {
    expect(extensionReminder({ ...base, overdue: false })).toEqual({
      params: {
        type: 'contract_extension_reminder',
        title: 'Responda ao pedido de extensão até qui, 08/10 às 12:00: Vídeo institucional',
        body: 'Aceite o novo prazo, sex, 16/10/2026, até 23:59, ou recuse. Sem resposta, o pedido expira e vale o prazo atual, sex, 09/10/2026, até 23:59.',
        data: { contractId: 3 },
      },
    });
  });

  it('com o prazo atual já vencido: não repete a data passada e diz que a disputa espera a decisão', () => {
    expect(extensionReminder({ ...base, overdue: true }).params.body).toBe(
      'Aceite o novo prazo, sex, 16/10/2026, até 23:59, ou recuse. Sem resposta, o pedido expira e vale o prazo atual, que já venceu. Enquanto você decide, a disputa automática espera.',
    );
  });
});

describe('revisionStalledNotices: revisão sem nova entrega há dias (RN-081)', () => {
  const base = {
    contractId: 3,
    title: 'Vídeo institucional',
    requestedClient: 'seg, 28/09 às 10:00',
    requestedFreelancer: 'seg, 28/09 às 11:00',
    days: 7,
    barter: false,
  };

  it('entrega única com valor: um aviso a cada parte, cada uma com a hora do pedido no próprio fuso, sem sanção; ao cliente, a mediação decide sobre o valor', () => {
    expect(revisionStalledNotices({ ...base, milestone: null })).toEqual({
      client: {
        params: {
          type: 'contract_revision_stalled',
          title: 'Revisão sem nova entrega há 7 dias: Vídeo institucional',
          body: 'Você pediu revisão em seg, 28/09 às 10:00 e ainda não houve nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala, e a mediação do Escambo decide sobre o valor.',
          data: { contractId: 3 },
        },
      },
      freelancer: {
        params: {
          type: 'contract_revision_stalled',
          title: 'Revisão esperando você há 7 dias: Vídeo institucional',
          body: 'O cliente pediu revisão em seg, 28/09 às 11:00. Registre a nova entrega ou combine pelo chat. Nada muda sozinho, mas qualquer um de vocês pode abrir uma disputa pela Sala.',
          data: { contractId: 3 },
        },
      },
    });
  });

  it('entrega única na troca: não há valor em garantia, o corpo do cliente termina na disputa, sem falar em valor', () => {
    const n = revisionStalledNotices({ ...base, barter: true, milestone: null });
    expect(n.client.params.body).toBe(
      'Você pediu revisão em seg, 28/09 às 10:00 e ainda não houve nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.',
    );
    expect(n.client.params.title).toBe('Revisão sem nova entrega há 7 dias: Vídeo institucional');
  });

  it('entrega única: a troca só muda o corpo do cliente; o aviso do freelancer é o mesmo', () => {
    expect(revisionStalledNotices({ ...base, barter: true, milestone: null }).freelancer).toEqual(
      revisionStalledNotices({ ...base, barter: false, milestone: null }).freelancer,
    );
  });

  it('marco: o título começa pelo fato (a revisão e os dias) e termina no marco, a contratação abre o corpo e os dois apontam o marco', () => {
    expect(
      revisionStalledNotices({ ...base, days: 9, milestone: { id: 5, title: 'Layout' } }),
    ).toEqual({
      client: {
        params: {
          type: 'contract_revision_stalled',
          title: 'Revisão sem nova entrega há 9 dias, marco «Layout»',
          body: 'Vídeo institucional: você pediu revisão em seg, 28/09 às 10:00 e o marco ainda não foi entregue de novo. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.',
          data: { contractId: 3, milestoneId: 5 },
        },
      },
      freelancer: {
        params: {
          type: 'contract_revision_stalled',
          title: 'Revisão esperando você há 9 dias, marco «Layout»',
          body: 'Vídeo institucional: o cliente pediu revisão em seg, 28/09 às 11:00. Entregue o marco de novo ou combine pelo chat; qualquer um de vocês pode abrir uma disputa pela Sala.',
          data: { contractId: 3, milestoneId: 5 },
        },
      },
    });
  });

  it('marco: troca ou não, o aviso é o mesmo e nunca fala em valor', () => {
    const milestone = { id: 5, title: 'Layout' };
    const barter = revisionStalledNotices({ ...base, barter: true, milestone });
    expect(barter).toEqual(revisionStalledNotices({ ...base, barter: false, milestone }));
    expect(barter.client.params.body).not.toContain('valor');
  });

  it.each([
    { name: 'entrega única', milestone: null },
    { name: 'marco', milestone: { id: 5, title: 'Layout' } },
  ])(
    '$name: os dois títulos começam por "Revisão" e dizem os dias antes do nome',
    ({ milestone }) => {
      const n = revisionStalledNotices({ ...base, days: 12, milestone });
      for (const t of [n.client.params.title, n.freelancer.params.title]) {
        expect(t.startsWith('Revisão ')).toBe(true);
        expect(t.indexOf('há 12 dias')).toBeLessThan(
          t.indexOf(milestone ? '«Layout»' : 'Vídeo institucional'),
        );
      }
    },
  );
});

describe('propriedade dos lembretes: a ação e a hora sobrevivem ao corte do título', () => {
  /** Um nome de contratação maior que o corte do título (150): só o que vem antes dele sobrevive. */
  const long = `Contratação ${'muito '.repeat(30)}longa`;
  const when = 'dom, 11/10 às 18:20';
  const day = 'sex, 09/10';
  const due = (id: number, dueAt: string, until = when): MilestoneDue => ({
    id,
    title: `Marco ${id}`,
    amount: 10,
    until,
    dueAt: new Date(dueAt),
  });

  /** Cada variante de lembrete, com a ação e o vencimento que o título precisa trazer. */
  const cases: { name: string; notice: DeadlineNotice; action: string; at: string }[] = [
    ...[true, false].map((cash) => ({
      name: `proposta (dinheiro: ${cash})`,
      notice: proposalReminder({
        contractId: 1,
        title: long,
        respondBy: when,
        cash,
        deadline: null,
      }),
      action: 'Responda à proposta',
      at: when,
    })),
    ...[false, true].flatMap((byMilestones) =>
      [false, true].map((canRequest) => ({
        name: `entrega (marcos: ${byMilestones}, extensão: ${canRequest})`,
        notice: deliveryReminder({
          contractId: 1,
          title: long,
          day,
          deadline: 'sex, 09/10/2026, até 23:59',
          byMilestones,
          missing: ['Layout'],
          canRequest,
          cancelOpen: true,
          partial: false,
          noticeAt: 'sáb, 10/10 às 09:00',
          graceHours: 24,
        }),
        action: 'Entregue',
        at: day,
      })),
    ),
    ...(['cash', 'credits', 'barter'] as const).map((mode) => ({
      name: `aprovação da entrega (${mode})`,
      notice: approvalReminder({
        contractId: 1,
        title: long,
        until: when,
        mode,
        price: 1,
        credits: 1,
      }),
      action: 'Aprove ou peça revisão',
      at: when,
    })),
    {
      name: 'aprovação de um marco',
      notice: milestoneApprovalReminder({
        contractId: 1,
        title: long,
        mode: 'cash',
        milestones: [due(5, '2026-10-11T21:20:00Z')],
      }),
      action: 'aprove ou peça revisão',
      at: when,
    },
    {
      name: 'aprovação de marcos com a mesma hora',
      notice: milestoneApprovalReminder({
        contractId: 1,
        title: long,
        mode: 'cash',
        milestones: [due(5, '2026-10-11T21:20:00Z'), due(6, '2026-10-11T21:20:00Z')],
      }),
      action: 'Aprove ou peça revisão',
      at: when,
    },
    {
      name: 'aprovação de marcos com horas diferentes',
      notice: milestoneApprovalReminder({
        contractId: 1,
        title: long,
        mode: 'cash',
        milestones: [
          due(6, '2026-10-12T12:00:00Z', 'seg, 12/10 às 09:00'),
          due(5, '2026-10-11T21:20:00Z'),
        ],
      }),
      action: 'esperam a sua resposta',
      at: when,
    },
    ...[false, true].map((overdue) => ({
      name: `extensão (prazo vencido: ${overdue})`,
      notice: extensionReminder({
        contractId: 1,
        title: long,
        until: when,
        proposed: 'sex, 16/10/2026, até 23:59',
        deadline: 'sex, 09/10/2026, até 23:59',
        overdue,
      }),
      action: 'Responda ao pedido de extensão',
      at: when,
    })),
  ];

  it.each(cases)(
    '$name: tipo *_reminder, a ação e o vencimento antes do nome da contratação e dentro dos 150 do corte, sem furar o silêncio',
    ({ notice, action, at }) => {
      const { type, title } = notice.params;
      expect(type.endsWith('_reminder')).toBe(true);
      const cut = title.slice(0, 150);
      expect(cut).toContain(action);
      expect(cut).toContain(at);
      // Quando o nome da contratação está no título, ele vem depois da ação e do vencimento.
      const name = title.indexOf(long);
      if (name >= 0) {
        expect(title.indexOf(action)).toBeLessThan(name);
        expect(title.indexOf(at)).toBeLessThan(name);
        expect(title.endsWith(`: ${long}`)).toBe(true);
      }
      expect(notice.passCategory).toBeUndefined();
    },
  );
});
