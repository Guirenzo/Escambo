import { describe, expect, it } from 'vitest';
import {
  milestonesTacitNotices,
  tacitApprovedNotices,
  type ApprovedMilestone,
} from './approval-notices';

/**
 * Os avisos da aprovação automática (ADR 58) palavra por palavra. A tácita move dinheiro sozinha,
 * então as duas partes são avisadas: o cliente lê o valor da contratação (ou do marco) e até quando
 * avalia; quem entrega, o líquido que entrou na carteira. Nenhum deles fura o silêncio.
 */

describe('tacitApprovedNotices: entrega única aprovada automaticamente', () => {
  const base = {
    contractId: 3,
    title: 'Vídeo institucional',
    price: 1234.5,
    net: 1049.33,
    dueClient: 'ter, 06/10 às 10:00',
    dueFreelancer: 'ter, 06/10 às 11:00',
    reviewUntil: 'ter, 13/10 às 11:00',
  };

  it('em dinheiro: o cliente lê o valor da contratação e até quando avalia; quem entrega, o líquido liberado', () => {
    expect(tacitApprovedNotices({ ...base, mode: 'cash' })).toEqual({
      client: {
        params: {
          type: 'contract_auto_approved',
          title: 'Aprovada automaticamente: Vídeo institucional',
          body: 'Sem resposta até ter, 06/10 às 10:00, a entrega foi aprovada e o pagamento foi liberado ao freelancer (contratação de R$ 1.234,50). Você pode avaliar até ter, 13/10 às 11:00.',
          data: { contractId: 3 },
        },
      },
      freelancer: {
        params: {
          type: 'contract_completed',
          title: 'Contratação concluída: Vídeo institucional',
          body: 'Sem resposta do cliente até ter, 06/10 às 11:00, a entrega foi aprovada automaticamente e R$ 1.049,33 foi liberado na sua carteira.',
          data: { contractId: 3 },
        },
      },
    });
  });

  it('em créditos com 1 crédito líquido: as duas cópias no singular', () => {
    const n = tacitApprovedNotices({ ...base, mode: 'credits', price: 1, net: 1 });
    expect(n.client.params.body).toBe(
      'Sem resposta até ter, 06/10 às 10:00, a entrega foi aprovada e o 1 crédito foi liberado ao freelancer. Você pode avaliar até ter, 13/10 às 11:00.',
    );
    expect(n.freelancer.params.body).toBe(
      'Sem resposta do cliente até ter, 06/10 às 11:00, a entrega foi aprovada automaticamente e 1 crédito foi liberado na sua carteira.',
    );
  });

  it('em créditos: as duas cópias dizem os créditos liberados (o líquido, não o preço), nunca reais', () => {
    const n = tacitApprovedNotices({ ...base, mode: 'credits', price: 45, net: 40 });
    expect(n.client.params.body).toBe(
      'Sem resposta até ter, 06/10 às 10:00, a entrega foi aprovada e os 40 créditos foram liberados ao freelancer. Você pode avaliar até ter, 13/10 às 11:00.',
    );
    expect(n.freelancer.params.body).toBe(
      'Sem resposta do cliente até ter, 06/10 às 11:00, a entrega foi aprovada automaticamente e 40 créditos foram liberados na sua carteira.',
    );
    expect(n.client.params.title).toBe('Aprovada automaticamente: Vídeo institucional');
    expect(n.freelancer.params.title).toBe('Contratação concluída: Vídeo institucional');
  });

  it('em créditos, 1 crédito liberado: quem entrega lê "1 crédito foi liberado na sua carteira", no singular', () => {
    const n = tacitApprovedNotices({ ...base, mode: 'credits', price: 2, net: 1 });
    expect(n.freelancer.params.body).toBe(
      'Sem resposta do cliente até ter, 06/10 às 11:00, a entrega foi aprovada automaticamente e 1 crédito foi liberado na sua carteira.',
    );
  });

  it('em créditos, nenhuma cópia fala em pagamento nem em reais', () => {
    const n = tacitApprovedNotices({ ...base, mode: 'credits', price: 45, net: 40 });
    for (const body of [n.client.params.body, n.freelancer.params.body]) {
      expect(body).not.toContain('pagamento');
      expect(body).not.toContain('R$');
    }
  });

  it('na troca não há dinheiro: a entrega conta para fechar a troca', () => {
    const n = tacitApprovedNotices({ ...base, mode: 'barter', price: 0, net: 0 });
    expect(n.client.params.body).toBe(
      'Sem resposta até ter, 06/10 às 10:00, a entrega foi aprovada e conta para fechar a troca. Você pode avaliar até ter, 13/10 às 11:00.',
    );
    expect(n.freelancer.params.body).toBe(
      'Sem resposta do cliente até ter, 06/10 às 11:00, a entrega foi aprovada automaticamente e conta para fechar a troca.',
    );
  });

  it('nenhuma cópia fura o silêncio, em nenhum modo', () => {
    for (const mode of ['cash', 'credits', 'barter'] as const) {
      const n = tacitApprovedNotices({ ...base, mode });
      expect(n.client.passCategory, mode).toBeUndefined();
      expect(n.freelancer.passCategory, mode).toBeUndefined();
    }
  });
});

describe('milestonesTacitNotices: marcos da mesma contratação aprovados na mesma rodada', () => {
  const layout: ApprovedMilestone = { id: 5, title: 'Layout', amount: 333.33, net: 283.33 };
  const front: ApprovedMilestone = { id: 6, title: 'Front', amount: 666.67, net: 566.67 };
  const base = {
    contractId: 31,
    title: 'Site em 3 etapas',
    mode: 'cash' as const,
    milestones: [layout],
    dueClient: 'ter, 06/10 às 17:20' as string | null,
    dueFreelancer: 'ter, 06/10 às 18:20' as string | null,
    completed: false,
    reviewUntil: null as string | null,
  };

  it('um marco, a contratação segue: o cliente lê o valor do marco; quem entrega, o líquido; os dois apontam o marco', () => {
    expect(milestonesTacitNotices(base)).toEqual({
      client: {
        params: {
          type: 'contract_auto_approved',
          title: 'Marco aprovado automaticamente: Layout',
          body: 'Site em 3 etapas: sem resposta até ter, 06/10 às 17:20, o marco foi aprovado e o pagamento dele foi liberado ao freelancer (marco de R$ 333,33).',
          data: { contractId: 31, milestoneId: 5 },
        },
      },
      freelancer: {
        params: {
          type: 'milestone_approved',
          title: 'Marco aprovado automaticamente: Layout',
          body: 'Site em 3 etapas: sem resposta do cliente até ter, 06/10 às 18:20, R$ 283,33 foi liberado na sua carteira.',
          data: { contractId: 31, milestoneId: 5 },
        },
      },
    });
  });

  it('um marco, o último: o cliente sabe que concluiu e até quando avalia; quem entrega recebe "contratação concluída"', () => {
    expect(
      milestonesTacitNotices({ ...base, completed: true, reviewUntil: 'ter, 13/10 às 19:45' }),
    ).toEqual({
      client: {
        params: {
          type: 'contract_auto_approved',
          title: 'Marco aprovado automaticamente: Layout',
          body: 'Site em 3 etapas: sem resposta até ter, 06/10 às 17:20, o marco foi aprovado e o pagamento dele foi liberado ao freelancer (marco de R$ 333,33). Era o que faltava: a contratação foi concluída, e você pode avaliar até ter, 13/10 às 19:45.',
          data: { contractId: 31, milestoneId: 5 },
        },
      },
      freelancer: {
        params: {
          type: 'contract_completed',
          title: 'Contratação concluída: Site em 3 etapas',
          body: 'Sem resposta do cliente até ter, 06/10 às 18:20, o último marco («Layout») foi aprovado automaticamente e R$ 283,33 foi liberado na sua carteira.',
          data: { contractId: 31, milestoneId: 5 },
        },
      },
    });
  });

  it('vários marcos com a mesma hora: um aviso só a cada parte, com a lista e a soma, sem apontar um marco', () => {
    expect(milestonesTacitNotices({ ...base, milestones: [layout, front] })).toEqual({
      client: {
        params: {
          type: 'contract_auto_approved',
          title: '2 marcos aprovados automaticamente: Site em 3 etapas',
          body: 'Sem resposta até ter, 06/10 às 17:20, os marcos «Layout» e «Front» foram aprovados e o pagamento deles foi liberado ao freelancer (R$ 1.000,00 ao todo).',
          data: { contractId: 31 },
        },
      },
      freelancer: {
        params: {
          type: 'milestone_approved',
          title: '2 marcos aprovados automaticamente: Site em 3 etapas',
          body: 'Sem resposta do cliente até ter, 06/10 às 18:20, os marcos «Layout» e «Front» foram aprovados e R$ 850,00 foi liberado na sua carteira.',
          data: { contractId: 31 },
        },
      },
    });
  });

  it('vários marcos, os últimos: concluiu, e quem entrega lê que eram os que faltavam', () => {
    const n = milestonesTacitNotices({
      ...base,
      milestones: [layout, front],
      completed: true,
      reviewUntil: 'ter, 13/10 às 19:45',
    });
    expect(n.client.params.body).toBe(
      'Sem resposta até ter, 06/10 às 17:20, os marcos «Layout» e «Front» foram aprovados e o pagamento deles foi liberado ao freelancer (R$ 1.000,00 ao todo). Era o que faltava: a contratação foi concluída, e você pode avaliar até ter, 13/10 às 19:45.',
    );
    expect(n.freelancer.params).toEqual({
      type: 'contract_completed',
      title: 'Contratação concluída: Site em 3 etapas',
      body: 'Sem resposta do cliente até ter, 06/10 às 18:20, os marcos «Layout» e «Front» foram aprovados automaticamente e R$ 850,00 foi liberado na sua carteira. Eram os que faltavam.',
      data: { contractId: 31 },
    });
  });

  it('marcos com horas diferentes: o aviso diz "na hora de cada um", sem inventar uma hora em comum', () => {
    const n = milestonesTacitNotices({
      ...base,
      milestones: [layout, front],
      dueClient: null,
      dueFreelancer: null,
    });
    expect(n.client.params.body).toBe(
      'Sem resposta na hora de cada um, os marcos «Layout» e «Front» foram aprovados e o pagamento deles foi liberado ao freelancer (R$ 1.000,00 ao todo).',
    );
    expect(n.freelancer.params.body).toBe(
      'Sem resposta do cliente na hora de cada um, os marcos «Layout» e «Front» foram aprovados e R$ 850,00 foi liberado na sua carteira.',
    );

    const done = milestonesTacitNotices({
      ...base,
      milestones: [layout, front],
      dueClient: null,
      dueFreelancer: null,
      completed: true,
      reviewUntil: 'ter, 13/10 às 19:45',
    });
    expect(done.freelancer.params.body).toBe(
      'Sem resposta do cliente na hora de cada um, os marcos «Layout» e «Front» foram aprovados automaticamente e R$ 850,00 foi liberado na sua carteira. Eram os que faltavam.',
    );
  });

  it('em créditos: um marco e vários dizem créditos, nunca reais nem "pagamento"', () => {
    const visit1: ApprovedMilestone = { id: 5, title: 'Visita 1', amount: 20, net: 20 };
    const visit2: ApprovedMilestone = { id: 6, title: 'Visita 2', amount: 20, net: 20 };

    const one = milestonesTacitNotices({ ...base, mode: 'credits', milestones: [visit1] });
    expect(one.client.params.body).toBe(
      'Site em 3 etapas: sem resposta até ter, 06/10 às 17:20, o marco foi aprovado e os créditos dele foram liberados ao freelancer (marco de 20 créditos).',
    );
    expect(one.freelancer.params.body).toBe(
      'Site em 3 etapas: sem resposta do cliente até ter, 06/10 às 18:20, 20 créditos foram liberados na sua carteira.',
    );

    const both = milestonesTacitNotices({
      ...base,
      mode: 'credits',
      milestones: [visit1, visit2],
      completed: true,
      reviewUntil: 'ter, 13/10 às 19:45',
    });
    expect(both.client.params.body).toBe(
      'Sem resposta até ter, 06/10 às 17:20, os marcos «Visita 1» e «Visita 2» foram aprovados e os créditos deles foram liberados ao freelancer (40 créditos ao todo). Era o que faltava: a contratação foi concluída, e você pode avaliar até ter, 13/10 às 19:45.',
    );
    expect(both.freelancer.params.body).toBe(
      'Sem resposta do cliente até ter, 06/10 às 18:20, os marcos «Visita 1» e «Visita 2» foram aprovados automaticamente e 40 créditos foram liberados na sua carteira. Eram os que faltavam.',
    );

    const last = milestonesTacitNotices({
      ...base,
      mode: 'credits',
      milestones: [visit2],
      completed: true,
      reviewUntil: 'ter, 13/10 às 19:45',
    });
    expect(last.freelancer.params.body).toBe(
      'Sem resposta do cliente até ter, 06/10 às 18:20, o último marco («Visita 2») foi aprovado automaticamente e 20 créditos foram liberados na sua carteira.',
    );
  });

  it('em créditos, um marco de 1 crédito: as duas cópias dizem "1 crédito", no singular', () => {
    const one: ApprovedMilestone = { id: 5, title: 'Visita 1', amount: 1, net: 1 };

    const n = milestonesTacitNotices({ ...base, mode: 'credits', milestones: [one] });
    expect(n.client.params.body).toBe(
      'Site em 3 etapas: sem resposta até ter, 06/10 às 17:20, o marco foi aprovado e os créditos dele foram liberados ao freelancer (marco de 1 crédito).',
    );
    expect(n.freelancer.params.body).toBe(
      'Site em 3 etapas: sem resposta do cliente até ter, 06/10 às 18:20, 1 crédito foi liberado na sua carteira.',
    );

    const last = milestonesTacitNotices({
      ...base,
      mode: 'credits',
      milestones: [one],
      completed: true,
      reviewUntil: 'ter, 13/10 às 19:45',
    });
    expect(last.freelancer.params.body).toBe(
      'Sem resposta do cliente até ter, 06/10 às 18:20, o último marco («Visita 1») foi aprovado automaticamente e 1 crédito foi liberado na sua carteira.',
    );
  });

  it('em créditos, dois marcos de 1 crédito: a soma de 2 vem no plural nas duas cópias', () => {
    const visits: ApprovedMilestone[] = [
      { id: 5, title: 'Visita 1', amount: 1, net: 1 },
      { id: 6, title: 'Visita 2', amount: 1, net: 1 },
    ];
    const n = milestonesTacitNotices({ ...base, mode: 'credits', milestones: visits });
    expect(n.client.params.body).toBe(
      'Sem resposta até ter, 06/10 às 17:20, os marcos «Visita 1» e «Visita 2» foram aprovados e os créditos deles foram liberados ao freelancer (2 créditos ao todo).',
    );
    expect(n.freelancer.params.body).toBe(
      'Sem resposta do cliente até ter, 06/10 às 18:20, os marcos «Visita 1» e «Visita 2» foram aprovados e 2 créditos foram liberados na sua carteira.',
    );
  });

  it('em créditos, nenhuma cópia fala em pagamento, com um marco ou vários, concluindo ou não', () => {
    const visit1: ApprovedMilestone = { id: 5, title: 'Visita 1', amount: 20, net: 20 };
    const visit2: ApprovedMilestone = { id: 6, title: 'Visita 2', amount: 20, net: 20 };
    for (const completed of [false, true]) {
      for (const milestones of [[visit1], [visit1, visit2]]) {
        const n = milestonesTacitNotices({
          ...base,
          mode: 'credits',
          milestones,
          completed,
          reviewUntil: 'ter, 13/10 às 19:45',
        });
        const label = `${milestones.length} marco(s), concluiu: ${completed}`;
        expect(n.client.params.body, label).not.toContain('pagamento');
        expect(n.freelancer.params.body, label).not.toContain('pagamento');
        expect(n.client.params.body, label).not.toContain('R$');
      }
    }
  });

  it('mais de três marcos: a lista vira a contagem, no título e no corpo', () => {
    const four = [1, 2, 3, 4].map((i) => ({ id: i, title: `M${i}`, amount: 10, net: 8.5 }));
    const n = milestonesTacitNotices({ ...base, milestones: four });
    expect(n.client.params.title).toBe('4 marcos aprovados automaticamente: Site em 3 etapas');
    expect(n.client.params.body).toBe(
      'Sem resposta até ter, 06/10 às 17:20, 4 marcos foram aprovados e o pagamento deles foi liberado ao freelancer (R$ 40,00 ao todo).',
    );
    expect(n.freelancer.params.body).toBe(
      'Sem resposta do cliente até ter, 06/10 às 18:20, 4 marcos foram aprovados e R$ 34,00 foi liberado na sua carteira.',
    );
  });

  it('concluiu sem a data da avaliação: o aviso do cliente não promete prazo para avaliar', () => {
    const n = milestonesTacitNotices({ ...base, completed: true, reviewUntil: null });
    expect(n.client.params.body).toBe(
      'Site em 3 etapas: sem resposta até ter, 06/10 às 17:20, o marco foi aprovado e o pagamento dele foi liberado ao freelancer (marco de R$ 333,33).',
    );
    expect(n.freelancer.params.type).toBe('contract_completed');
  });

  it('quem é avisado do quê: o cliente sempre pela aprovação automática; quem entrega, pela conclusão só quando concluiu; nada fura o silêncio', () => {
    for (const completed of [false, true]) {
      for (const milestones of [[layout], [layout, front]]) {
        const n = milestonesTacitNotices({
          ...base,
          milestones,
          completed,
          reviewUntil: 'ter, 13/10 às 19:45',
        });
        const label = `${milestones.length} marco(s), concluiu: ${completed}`;
        expect(n.client.params.type, label).toBe('contract_auto_approved');
        expect(n.freelancer.params.type, label).toBe(
          completed ? 'contract_completed' : 'milestone_approved',
        );
        // Só o aviso de um marco aponta o marco; o de vários aponta a contratação.
        const data =
          milestones.length === 1 ? { contractId: 31, milestoneId: 5 } : { contractId: 31 };
        expect(n.client.params.data, label).toEqual(data);
        expect(n.freelancer.params.data, label).toEqual(data);
        expect(n.client.passCategory, label).toBeUndefined();
        expect(n.freelancer.passCategory, label).toBeUndefined();
      }
    }
  });
});
