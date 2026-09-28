import { describe, expect, it } from 'vitest';
import {
  deadlineView,
  extensionRequestsLeft,
  extensionRequestsUsed,
  extensionRespondBy,
  decisionFloor,
  graceAfterDecision,
  graceEndFrom,
  noticeGraceEnd,
  owesDelivery,
  projectedNoticeAt,
  type DeadlineRow,
} from './deadline-grace';

/** Horário de Brasília (UTC−3), sem horário de verão. */
const brt = (s: string): Date => new Date(`${s.replace(' ', 'T')}-03:00`);
const SP = 'America/Sao_Paulo' as const;

const row = (over: Partial<DeadlineRow> = {}): DeadlineRow => ({
  status: 'accepted',
  deadline_at: brt('2026-10-02 23:59:59'),
  deadline_extended_at: null,
  overdue_notified_at: null,
  grace_ends_at: null,
  extension_status: 'none',
  extension_requests: 0,
  total_milestones: 0,
  undelivered_milestones: 0,
  deliveries_count: 0,
  first_delivered_at: null,
  ...over,
});

describe('R-VEZ: a RN-029 só cobra o que nunca foi entregue (ADR 57)', () => {
  it('owesDelivery: tabela verdade', () => {
    expect(owesDelivery(row())).toBe(true);
    expect(owesDelivery(row({ status: 'in_progress' }))).toBe(true);
    // revisão e entrega não são mais a vez de quem entrega
    expect(owesDelivery(row({ status: 'revision_requested' }))).toBe(false);
    expect(owesDelivery(row({ status: 'delivered' }))).toBe(false);
    expect(owesDelivery(row({ status: 'pending' }))).toBe(false);
    expect(owesDelivery(row({ deadline_at: null }))).toBe(false);
    // entrega única já entregue (não acontece em accepted, mas a conta não depende disso)
    expect(owesDelivery(row({ deliveries_count: 1 }))).toBe(false);
    // por marcos: algum financiado nunca entregue
    expect(owesDelivery(row({ total_milestones: 2, undelivered_milestones: 1 }))).toBe(true);
    expect(owesDelivery(row({ total_milestones: 2, undelivered_milestones: 0 }))).toBe(false);
  });

  it('pedidos: até 2, contando o pedido visível de uma linha antiga; nenhum depois do aceite', () => {
    expect(extensionRequestsLeft(row())).toBe(2);
    expect(
      extensionRequestsLeft(row({ extension_requests: 1, extension_status: 'declined' })),
    ).toBe(1);
    expect(extensionRequestsLeft(row({ extension_requests: 2, extension_status: 'expired' }))).toBe(
      0,
    );
    // linha de antes da 0027: contador zerado, mas um pedido recusado aparece
    expect(extensionRequestsUsed(row({ extension_status: 'declined' }))).toBe(1);
    expect(extensionRequestsLeft(row({ extension_status: 'declined' }))).toBe(1);
    expect(
      extensionRequestsLeft(
        row({
          extension_requests: 1,
          extension_status: 'accepted',
          deadline_extended_at: new Date(),
        }),
      ),
    ).toBe(0);
    expect(extensionRequestsLeft(row({ status: 'delivered' }))).toBe(0);
  });
});

describe('instantes gravados (R-HORA)', () => {
  it('graceEndFrom: aviso + carência, levado para as 9h se cair de noite', () => {
    expect(graceEndFrom(brt('2026-10-03 09:03:00'), 24, SP)).toEqual(brt('2026-10-04 09:03:00'));
    expect(graceEndFrom(brt('2026-10-03 20:40:00'), 24, SP)).toEqual(brt('2026-10-05 09:00:00'));
    expect(graceEndFrom(brt('2026-10-03 09:03:00.700'), 24, SP)).toEqual(
      brt('2026-10-04 09:03:00'),
    );
  });

  it('extensionRespondBy: 48 h, levadas para as 9h', () => {
    expect(
      extensionRespondBy({
        requestedAt: brt('2026-10-06 16:40:00'),
        proposed: brt('2026-10-20 23:59:59'),
        zone: SP,
      }),
    ).toEqual(brt('2026-10-08 16:40:00'));
    expect(
      extensionRespondBy({
        requestedAt: brt('2026-10-06 21:10:00'),
        proposed: brt('2026-10-20 23:59:59'),
        zone: SP,
      }),
    ).toEqual(brt('2026-10-09 09:00:00'));
  });

  it('extensionRespondBy: nunca depois do último instante de dia 12 h antes da data pedida', () => {
    // pedida qui 06:00 → −12 h = qua 18:00 (de dia) → responde até lá, antes das 48 h
    expect(
      extensionRespondBy({
        requestedAt: brt('2026-10-06 16:40:00'),
        proposed: brt('2026-10-08 06:00:00'),
        zone: SP,
      }),
    ).toEqual(brt('2026-10-07 18:00:00'));
    // pedida qui 10:00 → −12 h = qua 22:00 (noite) → as 20:29:59 de qua
    expect(
      extensionRespondBy({
        requestedAt: brt('2026-10-06 16:40:00'),
        proposed: brt('2026-10-08 10:00:00'),
        zone: SP,
      }),
    ).toEqual(brt('2026-10-07 20:29:59'));
  });

  it('extensionRespondBy: menos de 6 h para decidir é null (a data está perto demais)', () => {
    expect(
      extensionRespondBy({
        requestedAt: brt('2026-10-06 16:40:00'),
        proposed: brt('2026-10-07 07:00:00'),
        zone: SP,
      }),
    ).toBeNull();
  });

  it('graceAfterDecision: volta de onde parou (a espera não conta)', () => {
    // aviso sáb 09:00 → fim dom 09:00; pedido sáb 10:00; recusa sáb 16:00 (6 h de pausa)
    expect(
      graceAfterDecision({
        noticeAt: brt('2026-10-03 09:00:00'),
        graceEndsAt: brt('2026-10-04 09:00:00'),
        requestedAt: brt('2026-10-03 10:00:00'),
        decidedAt: brt('2026-10-03 16:00:00'),
        graceHours: 24,
        zone: SP,
      }),
    ).toEqual(brt('2026-10-04 15:00:00'));
  });

  it('graceAfterDecision: pedido que expira de noite ganha o piso de 6 h de dia', () => {
    // aviso sáb 09:00, fim dom 09:00; pedido sáb 20:00, expira seg 20:00: 48 h de pausa dão
    // ter 09:00; o piso de 12 h dá ter 08:00; as 6 h de dia (30 min na seg + 5h30 na ter) dão
    // ter 14:30, que vale
    expect(
      graceAfterDecision({
        noticeAt: brt('2026-10-03 09:00:00'),
        graceEndsAt: brt('2026-10-04 09:00:00'),
        requestedAt: brt('2026-10-03 20:00:00'),
        decidedAt: brt('2026-10-05 20:00:00'),
        graceHours: 24,
        zone: SP,
      }),
    ).toEqual(brt('2026-10-06 14:30:00'));
  });

  it('graceAfterDecision: recusa às 20:29 dá pelo menos 6 h de dia, e não só até as 9h', () => {
    // pedido sáb 20:00, recusa sáb 20:29: a pausa soma 29 min (dom 09:34); o piso de 12 h cairia
    // dom 08:29 (→ 09:00), mas as 6 h de dia vão até dom 14:59 — 1 min no sáb, 5h59 no dom.
    expect(
      graceAfterDecision({
        noticeAt: brt('2026-10-03 09:05:00'),
        graceEndsAt: brt('2026-10-04 09:05:00'),
        requestedAt: brt('2026-10-03 20:00:00'),
        decidedAt: brt('2026-10-03 20:29:00'),
        graceHours: 24,
        zone: SP,
      }),
    ).toEqual(brt('2026-10-04 14:59:00'));
  });

  it('graceAfterDecision: sem aviso dado, null (a fase 1 avisa depois)', () => {
    expect(
      graceAfterDecision({
        noticeAt: null,
        graceEndsAt: null,
        requestedAt: brt('2026-10-01 10:00:00'),
        decidedAt: brt('2026-10-01 12:00:00'),
        graceHours: 24,
        zone: SP,
      }),
    ).toBeNull();
  });

  it('graceAfterDecision: linha antiga sem fim gravado usa aviso + carência vigente', () => {
    expect(
      graceAfterDecision({
        noticeAt: brt('2026-10-03 09:00:00'),
        graceEndsAt: null,
        requestedAt: brt('2026-10-03 09:00:00'),
        decidedAt: brt('2026-10-03 11:00:00'),
        graceHours: 24,
        zone: SP,
      }),
    ).toEqual(brt('2026-10-04 11:00:00'));
  });
});

describe('deadlineView: o estado do prazo, na ordem', () => {
  const opts = (now: string) => ({ now: brt(now), graceHours: 24, zone: SP });

  it('sem prazo, encerrada, proposta', () => {
    expect(deadlineView(row({ deadline_at: null }), opts('2026-10-01 12:00:00')).state).toBe(
      'none',
    );
    for (const status of ['completed', 'cancelled', 'rejected', 'disputed']) {
      expect(deadlineView(row({ status }), opts('2026-10-01 12:00:00')).state).toBe('closed');
    }
    expect(deadlineView(row({ status: 'pending' }), opts('2026-10-01 12:00:00')).state).toBe(
      'proposal',
    );
  });

  it('running projeta o aviso às 9h depois do prazo e a disputa 24 h depois', () => {
    const v = deadlineView(row(), opts('2026-10-01 12:00:00'));
    expect(v.state).toBe('running');
    expect(v.noticeAt).toEqual(brt('2026-10-03 09:00:00'));
    expect(v.mediationAt).toEqual(brt('2026-10-04 09:00:00'));
    expect(v.extensionRequestsLeft).toBe(2);
  });

  it('due: vencido de madrugada, o aviso sai às 9h; já de dia, sai agora', () => {
    const night = deadlineView(row(), opts('2026-10-03 02:00:00'));
    expect(night.state).toBe('due');
    expect(night.noticeAt).toEqual(brt('2026-10-03 09:00:00'));
    // já de dia, com o job atrasado: o aviso projetado (09:00) já passou; a carência conta do
    // aviso real, que não sai antes de agora
    const day = deadlineView(row(), opts('2026-10-03 10:00:00'));
    expect(day.noticeAt).toEqual(brt('2026-10-03 09:00:00'));
    expect(day.mediationAt).toEqual(brt('2026-10-04 10:00:00'));
  });

  it('pedido recusado de noite depois do prazo: o aviso só sai às 9h, e a Sala e o cancelamento dizem o mesmo', () => {
    // prazo sex 23:59:59; pedido pendente segurou a fase 1; recusa sáb 22:00
    const r = row({
      extension_status: 'declined',
      extension_resolved_at: brt('2026-10-03 22:00:00'),
    });
    expect(projectedNoticeAt(r, SP)).toEqual(brt('2026-10-04 09:00:00'));
    const v = deadlineView(r, opts('2026-10-03 22:05:00'));
    expect(v).toMatchObject({ state: 'due', noticeAt: brt('2026-10-04 09:00:00') });
    // e a carência respeita o piso da decisão (12 h e 6 h de dia): com 2 h de carência, dom 15:00
    expect(noticeGraceEnd(r, brt('2026-10-04 09:00:00'), 2, SP)).toEqual(
      brt('2026-10-04 15:00:00'),
    );
    expect(noticeGraceEnd(r, brt('2026-10-04 09:00:00'), 24, SP)).toEqual(
      brt('2026-10-05 09:00:00'),
    );
    // recusa antes do prazo não mexe no aviso
    const antes = row({
      extension_status: 'declined',
      extension_resolved_at: brt('2026-10-02 12:00:00'),
    });
    expect(projectedNoticeAt(antes, SP)).toEqual(brt('2026-10-03 09:00:00'));
    expect(decisionFloor(brt('2026-10-03 20:29:00'), SP)).toEqual(brt('2026-10-04 14:59:00'));
  });

  it('grace usa a hora gravada; paused segura; met depois da entrega', () => {
    const notice = brt('2026-10-03 09:03:00');
    const ends = brt('2026-10-04 09:03:00');
    const g = deadlineView(
      row({ overdue_notified_at: notice, grace_ends_at: ends }),
      opts('2026-10-03 12:00:00'),
    );
    expect(g).toMatchObject({ state: 'grace', noticeAt: notice, mediationAt: ends });
    expect(
      deadlineView(
        row({ overdue_notified_at: notice, grace_ends_at: ends, extension_status: 'pending' }),
        opts('2026-10-03 12:00:00'),
      ),
    ).toMatchObject({ state: 'paused', noticeAt: notice, mediationAt: null });
    expect(
      deadlineView(
        row({ status: 'revision_requested', overdue_notified_at: notice }),
        opts('2026-10-03 12:00:00'),
      ).state,
    ).toBe('met');
    expect(
      deadlineView(
        row({ total_milestones: 2, undelivered_milestones: 0 }),
        opts('2026-10-03 12:00:00'),
      ).state,
    ).toBe('met');
  });
});
