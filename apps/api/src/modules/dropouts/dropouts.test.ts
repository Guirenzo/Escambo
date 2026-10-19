import { describe, expect, it } from 'vitest';
import {
  agreeUntil,
  canAgree,
  canAppeal,
  counts,
  DROPOUT_AGREE_DAYS,
  DROPOUT_ALERT_AT,
  DROPOUT_WINDOW_DAYS,
  dropoutSince,
  dropoutSummary,
  withdrawalPreview,
  type DropoutRow,
} from './dropouts';

const DAY = 24 * 60 * 60_000;
const date = (value: string) => new Date(value);
const offset = (at: Date, days: number) => new Date(at.getTime() + days * DAY);
const row = (at: Date, extra: Partial<DropoutRow> = {}): DropoutRow => ({
  dropped_at: at,
  client_agreed_at: null,
  appealed_at: null,
  decision: null,
  ...extra,
});
const NOW = date('2026-11-02T15:40:00-03:00');

describe('Janela de desistências (RN-026)', () => {
  it('fixa os números públicos em 60 dias, três desistências e sete dias para confirmar', () => {
    expect([DROPOUT_WINDOW_DAYS, DROPOUT_ALERT_AT, DROPOUT_AGREE_DAYS]).toEqual([60, 3, 7]);
  });

  it('conta dias corridos e preserva a hora, sem deslocar para a manhã', () => {
    const now = date('2026-11-02T23:41:32-03:00');
    expect(dropoutSince(now)).toEqual(date('2026-09-03T23:41:32-03:00'));
    expect(now).toEqual(date('2026-11-02T23:41:32-03:00'));
  });

  it.each([
    ['um milissegundo antes de 60 dias', -60 * DAY - 1, false],
    ['exatamente 60 dias atrás', -60 * DAY, true],
    ['um milissegundo dentro da janela', -60 * DAY + 1, true],
    ['agora', 0, true],
    ['um milissegundo no futuro', 1, false],
  ])('contagem: %s', (_label, delta, expected) => {
    expect(counts(row(new Date(NOW.getTime() + delta)), NOW)).toBe(expected);
  });

  it.each([
    ['sem decisão', {}, true],
    ['contestação aguardando decisão', { appealed_at: offset(NOW, -1) }, true],
    ['mantida pela equipe', { decision: 'upheld' as const }, true],
    ['dispensada pela equipe', { decision: 'excused' as const }, false],
    ['combinada pelo cliente', { client_agreed_at: offset(NOW, -1) }, false],
    [
      'combinada depois de ser mantida',
      { decision: 'upheld' as const, client_agreed_at: offset(NOW, -1) },
      false,
    ],
  ])('contagem: %s', (_label, state, expected) => {
    expect(counts(row(offset(NOW, -3), state), NOW)).toBe(expected);
  });
});

describe('Resumo público e duração do alerta', () => {
  it.each([0, 1, 2])('com %i desistências não mostra alerta nem uma data de término', (n) => {
    const rows = Array.from({ length: n }, (_, i) => row(offset(NOW, -i)));
    expect(dropoutSummary(rows, NOW)).toEqual({ count: n, alert: false, alertUntil: null });
  });

  it('usa o caso da ADR: 8/10, 20/10 e 2/11; o alerta deixa de existir em 8/12', () => {
    const rows = ['2026-10-08', '2026-10-20', '2026-11-02'].map((d) =>
      row(date(`${d}T15:40:00-03:00`)),
    );
    expect(dropoutSummary(rows, NOW)).toEqual({
      count: 3,
      alert: true,
      alertUntil: date('2026-12-07T15:40:00-03:00'),
    });
    expect(dropoutSummary(rows, date('2026-12-08T15:40:00-03:00'))).toEqual({
      count: 2,
      alert: false,
      alertUntil: null,
    });
  });

  it('com quatro fora de ordem termina na segunda mais antiga, sem reordenar a entrada', () => {
    const rows = [row(offset(NOW, -1)), row(offset(NOW, -30)), row(NOW), row(offset(NOW, -20))];
    const before = [...rows];
    Object.freeze(rows);
    expect(dropoutSummary(rows, NOW)).toEqual({
      count: 4,
      alert: true,
      alertUntil: offset(NOW, 40),
    });
    expect(rows).toEqual(before);
  });

  it('ignora as antigas, futuras e que não contam ao escolher a terceira mais recente', () => {
    const rows = [
      row(offset(NOW, -70)),
      row(offset(NOW, 1)),
      row(offset(NOW, -50), { decision: 'excused' }),
      row(offset(NOW, -40), { client_agreed_at: offset(NOW, -39) }),
      row(offset(NOW, -30)),
      row(offset(NOW, -20), { decision: 'upheld' }),
      row(offset(NOW, -10), { appealed_at: offset(NOW, -9) }),
    ];
    expect(dropoutSummary(rows, NOW)).toEqual({
      count: 3,
      alert: true,
      alertUntil: offset(NOW, 30),
    });
  });

  it('a fronteira do alerta segue a mesma inclusão de 60 dias da contagem', () => {
    const first = offset(NOW, -60);
    const rows = [row(first), row(offset(NOW, -10)), row(NOW)];
    expect(dropoutSummary(rows, NOW)).toEqual({ count: 3, alert: true, alertUntil: NOW });
    expect(dropoutSummary(rows, new Date(NOW.getTime() + 1))).toEqual({
      count: 2,
      alert: false,
      alertUntil: null,
    });
    expect(first).toEqual(offset(NOW, -60));
  });

  it('datas iguais são eventos diferentes e a data devolvida não altera os registros', () => {
    const at = offset(NOW, -5);
    const rows = [row(at), row(at), row(at), row(at)];
    const result = dropoutSummary(rows, NOW);
    expect(result).toEqual({ count: 4, alert: true, alertUntil: offset(NOW, 55) });
    result.alertUntil!.setTime(0);
    expect(at).toEqual(offset(NOW, -5));
    expect(dropoutSummary(rows, NOW).count).toBe(4);
  });
});

describe('Prévia informativa da desistência', () => {
  it('acrescenta só uma desistência virtual agora, sem alterar ou gravar os registros', () => {
    const rows = Object.freeze([row(offset(NOW, -20)), row(offset(NOW, -10))]);
    expect(withdrawalPreview(rows, NOW)).toEqual({ countAfter: 3, alertUntil: offset(NOW, 40) });
    expect(rows).toHaveLength(2);
    expect(dropoutSummary(rows, NOW)).toEqual({ count: 2, alert: false, alertUntil: null });
    expect(withdrawalPreview(rows, NOW)).toEqual({ countAfter: 3, alertUntil: offset(NOW, 40) });
  });

  it('abaixo de três mantém só a contagem informativa', () => {
    expect(withdrawalPreview([], NOW)).toEqual({ countAfter: 1, alertUntil: null });
    expect(withdrawalPreview([row(NOW)], NOW)).toEqual({ countAfter: 2, alertUntil: null });
  });

  it('se já havia alerta, o evento virtual pode estender o término', () => {
    const rows = [row(offset(NOW, -30)), row(offset(NOW, -20)), row(offset(NOW, -10))];
    expect(dropoutSummary(rows, NOW).alertUntil).toEqual(offset(NOW, 30));
    expect(withdrawalPreview(rows, NOW)).toEqual({ countAfter: 4, alertUntil: offset(NOW, 40) });
  });

  it('é um retrato: outra confirmação antes de cancelar muda o total efetivo', () => {
    const rows = [row(offset(NOW, -3)), row(offset(NOW, -1))];
    const preview = withdrawalPreview(rows, NOW);
    const after = [
      { ...rows[0]!, client_agreed_at: NOW },
      rows[1]!,
      row(new Date(NOW.getTime() + 1)),
    ];
    expect(preview.countAfter).toBe(3);
    expect(dropoutSummary(after, new Date(NOW.getTime() + 1))).toEqual({
      count: 2,
      alert: false,
      alertUntil: null,
    });
  });
});

describe('Confirmação e contestação', () => {
  const droppedAt = date('2026-10-08T21:15:30-03:00');

  it('a confirmação tem sete dias corridos a partir da desistência', () => {
    expect(agreeUntil(droppedAt)).toEqual(date('2026-10-15T21:15:30-03:00'));
    expect(droppedAt).toEqual(date('2026-10-08T21:15:30-03:00'));
  });

  it.each([
    ['antes da desistência', -1, false],
    ['na desistência', 0, true],
    ['no limite de sete dias', 7 * DAY, true],
    ['um milissegundo depois de sete dias', 7 * DAY + 1, false],
  ])('cliente pode confirmar: %s', (_label, delta, expected) => {
    expect(canAgree(row(droppedAt), new Date(droppedAt.getTime() + delta))).toBe(expected);
  });

  it('decisão upheld no dia dois permite confirmação do cliente no dia três', () => {
    const upheld = {
      ...row(droppedAt),
      appealed_at: offset(droppedAt, 1),
      decision: 'upheld' as const,
      decided_at: offset(droppedAt, 2),
    };
    const day3 = offset(droppedAt, 3);
    expect(counts(upheld, day3)).toBe(true);
    expect(canAppeal(upheld, day3)).toBe(false);
    expect(canAgree(upheld, day3)).toBe(true);

    const agreed = { ...upheld, client_agreed_at: day3 };
    expect(counts(agreed, day3)).toBe(false);
    expect(canAgree(agreed, day3)).toBe(false);
    expect(canAppeal(agreed, day3)).toBe(false);
    expect(counts(agreed, offset(droppedAt, 6))).toBe(false);
  });

  it('contestação pendente não bloqueia a confirmação e continua contando', () => {
    const pending = row(droppedAt, { appealed_at: offset(droppedAt, 1) });
    const now = offset(droppedAt, 2);
    expect(counts(pending, now)).toBe(true);
    expect(canAgree(pending, now)).toBe(true);
    expect(canAppeal(pending, now)).toBe(false);
  });

  it('excused não volta a contar nem reabre a confirmação ou a contestação', () => {
    const excused = row(droppedAt, { decision: 'excused' });
    for (const days of [2, 3, 7, 59]) {
      const now = offset(droppedAt, days);
      expect(counts(excused, now)).toBe(false);
      expect(canAgree(excused, now)).toBe(false);
      expect(canAppeal(excused, now)).toBe(false);
    }
  });

  it('confirmação registrada é estável e impede uma segunda confirmação', () => {
    const agreed = row(droppedAt, { client_agreed_at: offset(droppedAt, 1) });
    for (const days of [1, 2, 7]) {
      expect(canAgree(agreed, offset(droppedAt, days))).toBe(false);
      expect(counts(agreed, offset(droppedAt, days))).toBe(false);
    }
  });

  it('pode contestar até a fronteira inclusiva de 60 dias, sem contestação ou decisão', () => {
    const original = row(droppedAt);
    expect(canAppeal(original, droppedAt)).toBe(true);
    expect(canAppeal(original, offset(droppedAt, 60))).toBe(true);
    expect(canAppeal(original, new Date(offset(droppedAt, 60).getTime() + 1))).toBe(false);
    expect(canAppeal(original, new Date(droppedAt.getTime() - 1))).toBe(false);
  });

  it.each([
    ['contestada', { appealed_at: offset(droppedAt, 1) }],
    ['mantida', { decision: 'upheld' as const }],
    ['dispensada', { decision: 'excused' as const }],
    ['combinada', { client_agreed_at: offset(droppedAt, 1) }],
  ])('não permite contestar novamente a desistência %s', (_label, state) => {
    expect(canAppeal(row(droppedAt, state), offset(droppedAt, 3))).toBe(false);
  });
});
