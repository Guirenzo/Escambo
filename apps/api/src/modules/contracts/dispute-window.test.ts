import { describe, expect, it } from 'vitest';
import type { ContractRow } from './contracts.repository';
import {
  DISPUTE_TACIT_MARGIN_MS,
  DISPUTE_WAIT_MS,
  deliveryDisputeOpensAt,
  disputeOpen,
  disputeOpensAt,
  firstDeliveryAt,
  windowFacts,
  type DisputeWindowFacts,
  type DisputeWindowRow,
} from './dispute-window';

/** Todos os exemplos da tabela do ADR 61 estão no horário de Brasília. */
const brt = (value: string): Date => new Date(`${value.replace(' ', 'T')}-03:00`);
const HOUR_MS = 3_600_000;
const monday = brt('2026-10-05 10:00:00');
const tuesdayDelivery = brt('2026-10-06 18:20:00');
const wednesday = brt('2026-10-07 10:00:00');

const facts = (overrides: Partial<DisputeWindowFacts> = {}): DisputeWindowFacts => ({
  status: 'accepted',
  acceptedAt: monday,
  createdAt: brt('2026-10-01 10:00:00'),
  firstDeliveredAt: null,
  approvalDueAt: null,
  nextMilestoneApprovalAt: null,
  deliveryDisputeOpensAt: null,
  nextMilestoneDisputeOpensAt: null,
  ...overrides,
});

const row = (overrides: Partial<DisputeWindowRow> = {}): DisputeWindowRow => ({
  status: 'accepted',
  accepted_at: monday,
  created_at: brt('2026-10-01 10:00:00'),
  ...overrides,
});

describe('RN-062: tabela da janela manual do ADR 61', () => {
  const cases: { name: string; input: DisputeWindowFacts; expected: Date }[] = [
    { name: '1. sem entrega: 48 h depois do aceite', input: facts(), expected: wednesday },
    {
      name: '2. legado sem aceite: 48 h depois da criação',
      input: facts({ acceptedAt: null, createdAt: monday }),
      expected: wednesday,
    },
    {
      name: '3. entrega com tácita em cinco dias',
      input: facts({
        status: 'delivered',
        firstDeliveredAt: tuesdayDelivery,
        approvalDueAt: brt('2026-10-11 18:20:00'),
      }),
      expected: brt('2026-10-08 18:20:00'),
    },
    {
      name: '4. tácita em um dia: aberta desde a entrega',
      input: facts({
        status: 'delivered',
        firstDeliveredAt: tuesdayDelivery,
        approvalDueAt: brt('2026-10-07 18:20:00'),
      }),
      expected: tuesdayDelivery,
    },
    {
      name: '5. tácita em dois dias: aberta um dia depois da entrega',
      input: facts({
        status: 'delivered',
        firstDeliveredAt: tuesdayDelivery,
        approvalDueAt: brt('2026-10-08 18:20:00'),
      }),
      expected: brt('2026-10-07 18:20:00'),
    },
    {
      name: '6. teto usa a tácita já levada para as 9h',
      input: facts({
        status: 'delivered',
        firstDeliveredAt: brt('2026-10-06 22:00:00'),
        approvalDueAt: brt('2026-10-08 09:00:00'),
      }),
      expected: brt('2026-10-07 09:00:00'),
    },
    {
      name: '7. revisão: 48 h da primeira entrega, sem teto',
      input: facts({ status: 'revision_requested', firstDeliveredAt: monday }),
      expected: wednesday,
    },
    {
      name: '8. reentrega não move a primeira entrega',
      input: facts({
        status: 'delivered',
        firstDeliveredAt: monday,
        approvalDueAt: brt('2026-10-12 08:00:00'),
      }),
      expected: wednesday,
    },
    {
      name: '9. primeiro marco entregue abre a janela',
      input: facts({
        firstDeliveredAt: monday,
        nextMilestoneApprovalAt: brt('2026-10-10 10:00:00'),
      }),
      expected: wednesday,
    },
    {
      name: '10. marco reentregue: primeira entrega gravada não anda',
      input: windowFacts(
        row({
          status: 'in_progress',
          first_delivery_at: monday,
          first_delivered_at: brt('2026-10-07 09:00:00'),
          next_milestone_approval_at: brt('2026-10-12 09:00:00'),
        }),
      ),
      expected: wednesday,
    },
    {
      name: '11. teto vem da menor tácita dos marcos entregues',
      input: facts({
        status: 'in_progress',
        firstDeliveredAt: brt('2026-10-10 10:00:00'),
        nextMilestoneApprovalAt: new Date(
          Math.min(brt('2026-10-13 10:00:00').getTime(), brt('2026-10-12 10:00:00').getTime()),
        ),
      }),
      expected: brt('2026-10-11 10:00:00'),
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(disputeOpensAt(input)).toEqual(expected);
    expect(disputeOpen(input, new Date(expected.getTime() - 1))).toBe(false);
    expect(disputeOpen(input, expected)).toBe(true);
    expect(disputeOpen(input, new Date(expected.getTime() + 1))).toBe(true);
  });

  it.each(['disputed', 'completed', 'cancelled', 'pending', 'rejected'])(
    '12. estado %s não permite disputa manual',
    (status) => {
      const input = facts({ status, firstDeliveredAt: monday });
      expect(disputeOpensAt(input)).toBeNull();
      expect(disputeOpen(input, brt('2026-10-30 10:00:00'))).toBe(false);
    },
  );
});

describe('RN-062: primeira entrega e teto', () => {
  it('a espera é corrida, inclusive à noite; não lê o relógio nem leva para as 9h', () => {
    const input = facts({ acceptedAt: brt('2026-10-05 22:35:00') });
    expect(disputeOpensAt(input)).toEqual(brt('2026-10-07 22:35:00'));
  });

  it('a primeira entrega depois da abertura inicia outra espera uma vez; reentregas não a reiniciam', () => {
    const beforeDelivery = facts();
    const first = brt('2026-10-08 10:00:00');
    expect(disputeOpen(beforeDelivery, first)).toBe(true);

    const firstAt = firstDeliveryAt(null, [], first);
    const delivered = facts({ status: 'delivered', firstDeliveredAt: firstAt });
    const opensAt = brt('2026-10-10 10:00:00');
    expect(disputeOpensAt(delivered)).toEqual(opensAt);
    expect(disputeOpen(delivered, first)).toBe(false);
    expect(disputeOpen(delivered, opensAt)).toBe(true);

    for (const status of ['revision_requested', 'delivered']) {
      const nextDelivery = brt('2026-10-11 11:00:00');
      const preserved = firstDeliveryAt(firstAt, [nextDelivery], nextDelivery);
      const reentered = facts({ status, firstDeliveredAt: preserved });
      expect(disputeOpensAt(reentered)).toEqual(opensAt);
      expect(disputeOpen(reentered, nextDelivery)).toBe(true);
    }
  });

  it('o teto de um dia também vale quando a primeira entrega reabre a espera', () => {
    const first = brt('2026-10-08 10:00:00');
    expect(disputeOpen(facts(), first)).toBe(true);
    const delivered = facts({
      status: 'delivered',
      firstDeliveredAt: first,
      approvalDueAt: brt('2026-10-09 10:00:00'),
    });
    expect(disputeOpensAt(delivered)).toEqual(first);
    expect(disputeOpen(delivered, first)).toBe(true);
  });

  it('revisão ignora a tácita suspensa; sem entrega o aceite vale apesar de datas antigas de tácita', () => {
    const cap = brt('2026-10-06 10:00:00');
    expect(
      disputeOpensAt(
        facts({
          status: 'revision_requested',
          firstDeliveredAt: monday,
          approvalDueAt: cap,
          nextMilestoneApprovalAt: cap,
        }),
      ),
    ).toEqual(wednesday);
    expect(
      disputeOpensAt(
        facts({
          approvalDueAt: cap,
          nextMilestoneApprovalAt: cap,
          deliveryDisputeOpensAt: cap,
          nextMilestoneDisputeOpensAt: cap,
        }),
      ),
    ).toEqual(wednesday);
  });

  it('cada forma usa sua tácita: entrega única usa a contratação; accepted/in_progress usam marcos', () => {
    const single = brt('2026-10-06 10:00:00');
    const milestone = brt('2026-10-07 10:00:00');
    const input = facts({
      firstDeliveredAt: monday,
      approvalDueAt: single,
      nextMilestoneApprovalAt: milestone,
    });
    expect(disputeOpensAt({ ...input, status: 'delivered' })).toEqual(monday);
    for (const status of ['accepted', 'in_progress']) {
      expect(disputeOpensAt({ ...input, status })).toEqual(brt('2026-10-06 10:00:00'));
    }
  });

  it('aprovar o marco que fornecia o teto pode adiar a abertura; a primeira entrega permanece igual', () => {
    const waiting = facts({
      status: 'in_progress',
      firstDeliveredAt: monday,
      nextMilestoneApprovalAt: brt('2026-10-06 10:00:00'),
    });
    expect(disputeOpensAt(waiting)).toEqual(monday);
    expect(disputeOpensAt({ ...waiting, nextMilestoneApprovalAt: null })).toEqual(wednesday);
    expect(waiting.firstDeliveredAt).toEqual(monday);
  });

  it.each([1, 2])(
    'snapshot da tácita em %i dia(s) mantém a disputa na revisão e na reentrega',
    (days) => {
      const due = new Date(monday.getTime() + days * 24 * HOUR_MS);
      const saved = deliveryDisputeOpensAt(monday, due);
      const initial = facts({
        status: 'delivered',
        firstDeliveredAt: monday,
        approvalDueAt: due,
        deliveryDisputeOpensAt: saved,
      });
      const afterOpening = new Date(saved.getTime() + HOUR_MS);
      expect(disputeOpen(initial, afterOpening)).toBe(true);

      const revision = { ...initial, status: 'revision_requested', approvalDueAt: null };
      expect(disputeOpensAt(revision)).toEqual(saved);
      expect(disputeOpen(revision, afterOpening)).toBe(true);

      const newDue = new Date(afterOpening.getTime() + 5 * 24 * HOUR_MS);
      const afterReDelivery = {
        ...initial,
        approvalDueAt: newDue,
        deliveryDisputeOpensAt: deliveryDisputeOpensAt(monday, newDue, saved),
      };
      expect(disputeOpensAt(afterReDelivery)).toEqual(saved);
      expect(disputeOpen(afterReDelivery, afterOpening)).toBe(true);
    },
  );

  it('snapshot impede que a reentrega noturna com tácita humanizada feche a disputa', () => {
    const saved = deliveryDisputeOpensAt(monday, brt('2026-10-06 10:00:00'));
    const redelivered = facts({
      status: 'delivered',
      firstDeliveredAt: monday,
      approvalDueAt: brt('2026-10-07 09:00:00'),
      deliveryDisputeOpensAt: saved,
    });
    expect(disputeOpensAt(redelivered)).toEqual(monday);
    expect(disputeOpen(redelivered, brt('2026-10-05 22:00:00'))).toBe(true);
  });

  it('snapshot do marco continua no agregado enquanto ele está em revisão e após reentrega', () => {
    const saved = deliveryDisputeOpensAt(monday, brt('2026-10-06 10:00:00'));
    const revising = facts({
      status: 'in_progress',
      firstDeliveredAt: monday,
      nextMilestoneApprovalAt: null,
      nextMilestoneDisputeOpensAt: saved,
    });
    expect(disputeOpensAt(revising)).toEqual(monday);
    expect(disputeOpen(revising, brt('2026-10-05 11:00:00'))).toBe(true);
    const newDue = brt('2026-10-10 12:00:00');
    const afterReDelivery = {
      ...revising,
      nextMilestoneApprovalAt: newDue,
      nextMilestoneDisputeOpensAt: deliveryDisputeOpensAt(monday, newDue, saved),
    };
    expect(disputeOpensAt(afterReDelivery)).toEqual(monday);
  });

  it('snapshot do marco aprovado sai do agregado, permitindo o adiamento aceito no ADR', () => {
    const saved = deliveryDisputeOpensAt(monday, brt('2026-10-06 10:00:00'));
    const beforeApproval = facts({
      status: 'accepted',
      firstDeliveredAt: monday,
      nextMilestoneDisputeOpensAt: saved,
    });
    expect(disputeOpensAt(beforeApproval)).toEqual(monday);
    expect(disputeOpensAt({ ...beforeApproval, nextMilestoneDisputeOpensAt: null })).toEqual(
      wednesday,
    );
  });

  it('sem snapshot, o legado continua com a conta C.2 até o preenchimento transacional', () => {
    const beforeRevision = facts({
      status: 'delivered',
      firstDeliveredAt: monday,
      approvalDueAt: brt('2026-10-06 10:00:00'),
    });
    expect(disputeOpensAt(beforeRevision)).toEqual(monday);
    expect(
      disputeOpensAt({ ...beforeRevision, status: 'revision_requested', approvalDueAt: null }),
    ).toEqual(wednesday);
  });

  it.each(['delivered', 'revision_requested', 'accepted', 'in_progress'])(
    'snapshot histórico prevalece sobre tácita inferida depois do rollout: %s',
    (status) => {
      const input = facts({
        status,
        firstDeliveredAt: monday,
        approvalDueAt: brt('2026-10-06 10:00:00'),
        nextMilestoneApprovalAt: brt('2026-10-06 10:00:00'),
        deliveryDisputeOpensAt: wednesday,
        nextMilestoneDisputeOpensAt: wednesday,
      });
      const opens = disputeOpensAt(input)!;
      expect(opens).toEqual(wednesday);
      expect(disputeOpen(input, monday)).toBe(false);
      expect(disputeOpen(input, wednesday)).toBe(true);
      opens.setTime(0);
      expect(input.deliveryDisputeOpensAt).toEqual(wednesday);
      expect(input.nextMilestoneDisputeOpensAt).toEqual(wednesday);
    },
  );
});

describe('deliveryDisputeOpensAt: snapshot por unidade, sem alterar os instantes recebidos', () => {
  it('grava a menor abertura entre primeira entrega + 48 h e tácita - 24 h', () => {
    expect(deliveryDisputeOpensAt(monday, null)).toEqual(wednesday);
    expect(deliveryDisputeOpensAt(monday, brt('2026-10-06 10:00:00'))).toEqual(monday);
    expect(deliveryDisputeOpensAt(monday, brt('2026-10-07 10:00:00'))).toEqual(
      brt('2026-10-06 10:00:00'),
    );
    expect(deliveryDisputeOpensAt(monday, brt('2026-10-10 10:00:00'))).toEqual(wednesday);
  });

  it('reentrega com teto mais cedo pode antecipar, nunca adiar a abertura gravada', () => {
    const previous = brt('2026-10-06 10:00:00');
    expect(deliveryDisputeOpensAt(monday, brt('2026-10-10 10:00:00'), previous)).toEqual(previous);
    expect(deliveryDisputeOpensAt(monday, brt('2026-10-06 10:00:00'), previous)).toEqual(monday);
    expect(deliveryDisputeOpensAt(monday, null, previous)).toEqual(previous);
  });

  it('retorna um objeto independente sem mutar os snapshots ou as datas de entrega', () => {
    const first = new Date(monday.getTime());
    const due = brt('2026-10-07 10:00:00');
    const previous = brt('2026-10-06 10:00:00');
    const result = deliveryDisputeOpensAt(first, due, previous);
    expect(result).not.toBe(previous);
    result.setTime(0);
    expect(first).toEqual(monday);
    expect(due).toEqual(brt('2026-10-07 10:00:00'));
    expect(previous).toEqual(brt('2026-10-06 10:00:00'));
  });
});

describe('windowFacts: compatibilidade com a linha legada e o snapshot futuro', () => {
  it('aceita estruturalmente ContractRow da versão atual, sem exigir as novas colunas', () => {
    const readCurrentRow = (current: ContractRow): DisputeWindowFacts => windowFacts(current);
    expect(readCurrentRow).toBeTypeOf('function');
    const legacy = row({ accepted_at: null, created_at: monday, first_delivered_at: monday });
    const mapped = windowFacts(legacy);
    expect(mapped).toEqual(
      facts({ acceptedAt: null, createdAt: monday, firstDeliveredAt: monday }),
    );
  });

  it('a primeira entrega gravada prevalece sobre o cálculo que andou com a reentrega', () => {
    const mapped = windowFacts(
      row({ first_delivery_at: monday, first_delivered_at: brt('2026-10-07 09:00:00') }),
    );
    expect(mapped.firstDeliveredAt).toEqual(monday);
    expect(disputeOpensAt(mapped)).toEqual(wednesday);
  });

  it('snapshot nulo usa o cálculo legado; campos ausentes continuam nulos', () => {
    expect(
      windowFacts(row({ first_delivery_at: null, first_delivered_at: monday })).firstDeliveredAt,
    ).toEqual(monday);
    expect(windowFacts(row()).firstDeliveredAt).toBeNull();
    expect(windowFacts(row()).approvalDueAt).toBeNull();
    expect(windowFacts(row()).nextMilestoneApprovalAt).toBeNull();
    expect(windowFacts(row()).deliveryDisputeOpensAt).toBeNull();
    expect(windowFacts(row()).nextMilestoneDisputeOpensAt).toBeNull();
  });

  it('mapeia os snapshots futuros sem confundir a entrega única com o agregado dos marcos', () => {
    const single = brt('2026-10-06 10:00:00');
    const milestone = monday;
    const mapped = windowFacts(
      row({ delivery_dispute_opens_at: single, next_milestone_dispute_opens_at: milestone }),
    );
    expect(mapped.deliveryDisputeOpensAt).toEqual(single);
    expect(mapped.nextMilestoneDisputeOpensAt).toEqual(milestone);
    mapped.deliveryDisputeOpensAt!.setTime(0);
    mapped.nextMilestoneDisputeOpensAt!.setTime(0);
    expect(single).toEqual(brt('2026-10-06 10:00:00'));
    expect(milestone).toEqual(monday);
  });

  it('não compartilha objetos Date mutáveis com a linha do banco', () => {
    const source = row({ first_delivery_at: new Date(monday.getTime()) });
    const before = source.first_delivery_at!.getTime();
    const mapped = windowFacts(source);
    mapped.firstDeliveredAt!.setTime(0);
    mapped.acceptedAt!.setTime(0);
    mapped.createdAt.setTime(0);
    expect(source.first_delivery_at!.getTime()).toBe(before);
    expect(source.accepted_at).toEqual(monday);
    expect(source.created_at).toEqual(brt('2026-10-01 10:00:00'));
  });
});

describe('firstDeliveryAt: preservar o legado antes da reentrega e do reparo', () => {
  it('sem entrega anterior, grava a atual com precisão de segundo', () => {
    const now = brt('2026-10-06 18:20:00.987');
    expect(firstDeliveryAt(null, [null, undefined], now)).toEqual(tuesdayDelivery);
    expect(now.getMilliseconds()).toBe(987);
  });

  it('usa a menor data não nula entre entrega, marco e histórico, sem depender da ordem', () => {
    const history = brt('2026-10-05 10:00:00.100');
    const milestone = brt('2026-10-07 09:00:00');
    const single = brt('2026-10-06 18:20:00');
    const now = brt('2026-10-08 10:00:00');
    expect(firstDeliveryAt(undefined, [null, milestone, single, history], now)).toEqual(monday);
    expect(firstDeliveryAt(null, [history, null, single, milestone], now)).toEqual(monday);
  });

  it('uma data gravada nunca muda, mesmo com candidato mais antigo, e não é arredondada de novo', () => {
    const existing = brt('2026-10-05 10:00:00.456');
    const result = firstDeliveryAt(existing, [brt('2026-10-01 10:00:00')], tuesdayDelivery);
    expect(result).toEqual(existing);
    expect(result).not.toBe(existing);
    result.setTime(0);
    expect(existing).toEqual(brt('2026-10-05 10:00:00.456'));
  });

  it('rollout: marco reentregue antes do reparo mantém a entrega original do histórico', () => {
    const reDelivery = brt('2026-10-07 09:00:00');
    // O marco já foi reentregue uma vez pela API anterior; a nota histórica preserva a primeira.
    const saved = firstDeliveryAt(null, [tuesdayDelivery, monday], reDelivery);
    const afterReDelivery = windowFacts(
      row({
        status: 'in_progress',
        first_delivery_at: saved,
        first_delivered_at: reDelivery,
        next_milestone_approval_at: brt('2026-10-12 09:00:00'),
      }),
    );
    expect(saved).toEqual(monday);
    expect(disputeOpensAt(afterReDelivery)).toEqual(wednesday);
    const afterRepair = firstDeliveryAt(saved, [reDelivery, monday], reDelivery);
    expect(afterRepair).toEqual(saved);
    expect(disputeOpensAt({ ...afterReDelivery, firstDeliveredAt: afterRepair })).toEqual(
      wednesday,
    );
  });

  it('rollout: entrega única antiga também prevalece sobre a reentrega atual', () => {
    const reDelivery = brt('2026-10-07 09:00:00');
    const saved = firstDeliveryAt(null, [monday], reDelivery);
    expect(disputeOpensAt(facts({ status: 'delivered', firstDeliveredAt: saved }))).toEqual(
      wednesday,
    );
  });
});

describe('RN-062: propriedades com 10.000 casos de semente fixa', () => {
  it('respeita o teto e preserva a abertura ao passar por revisão e trocar a tácita na reentrega', () => {
    let seed = 0x61e5ca;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const base = brt('2026-01-01 00:00:00').getTime();
    const statuses = ['accepted', 'in_progress', 'delivered'];

    for (let i = 0; i < 10_000; i++) {
      const first = new Date(base + Math.floor(random() * 365 * 24 * 3_600) * 1000);
      const status = statuses[Math.floor(random() * statuses.length)]!;
      const approval = new Date(first.getTime() + (24 + Math.floor(random() * 240)) * HOUR_MS);
      const capped = facts({
        status,
        firstDeliveredAt: first,
        approvalDueAt: status === 'delivered' ? approval : null,
        nextMilestoneApprovalAt: status === 'delivered' ? null : approval,
      });
      const opening = disputeOpensAt(capped)!;
      expect(opening.getTime()).toBeLessThanOrEqual(approval.getTime() - DISPUTE_TACIT_MARGIN_MS);
      const noCap = { ...capped, approvalDueAt: null, nextMilestoneApprovalAt: null };
      expect(disputeOpensAt(noCap)!.getTime()).toBe(first.getTime() + DISPUTE_WAIT_MS);

      const later = new Date(first.getTime() + (1 + Math.floor(random() * 720)) * HOUR_MS);
      const preserved = firstDeliveryAt(first, [later], later);
      const saved = deliveryDisputeOpensAt(first, approval);
      const single = status === 'delivered';
      const revising = facts({
        status: single ? 'revision_requested' : status,
        firstDeliveredAt: first,
        deliveryDisputeOpensAt: single ? saved : null,
        nextMilestoneDisputeOpensAt: single ? null : saved,
      });
      expect(disputeOpensAt(revising)).toEqual(opening);
      expect(disputeOpen(revising, opening)).toBe(true);

      const newApproval = new Date(later.getTime() + (24 + Math.floor(random() * 240)) * HOUR_MS);
      const newSaved = deliveryDisputeOpensAt(first, newApproval, saved);
      const afterReDelivery = windowFacts(
        row({
          status,
          first_delivery_at: preserved,
          first_delivered_at: later,
          approval_due_at: single ? newApproval : null,
          next_milestone_approval_at: single ? null : newApproval,
          delivery_dispute_opens_at: single ? newSaved : null,
          next_milestone_dispute_opens_at: single ? null : newSaved,
        }),
      );
      expect(disputeOpensAt(afterReDelivery)!.getTime()).toBeLessThanOrEqual(opening.getTime());
      expect(disputeOpen(afterReDelivery, opening)).toBe(true);
      expect(disputeOpensAt(afterReDelivery)!.getTime()).toBeLessThanOrEqual(
        newApproval.getTime() - DISPUTE_TACIT_MARGIN_MS,
      );
    }
  });
});
