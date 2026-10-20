import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClockForTests } from '../../utils/clock';
import type { FullDropoutRow } from './dropouts.repository';
import { dropoutsService, toMyDropout } from './dropouts.service';

const { repo, notify } = vi.hoisted(() => ({
  repo: {
    listCounting: vi.fn(),
    listMine: vi.fn(),
    acceptedInWindow: vi.fn(),
    agree: vi.fn(),
    appeal: vi.fn(),
    listAppealed: vi.fn(),
    userIdByUlid: vi.fn(),
    decide: vi.fn(),
    reconcileReviews: vi.fn(),
    findReviewPending: vi.fn(),
    saveDecisionNotification: vi.fn(),
  },
  notify: vi.fn(),
}));
vi.mock('./dropouts.repository', () => ({ dropoutsRepository: repo }));
vi.mock('../notifications/notifications.service', () => ({
  notificationsService: {
    dispatch: (saved: { userId: number; params: unknown }) => notify(saved.userId, saved.params),
  },
}));
const NOW = new Date('2026-10-09T15:00:00Z');
const DAY = 86_400_000;
const row = (extra: Partial<Omit<FullDropoutRow, 'constructor'>> = {}) =>
  ({
    id: 12,
    contract_id: 31,
    client_id: 7,
    freelancer_id: 44,
    contract_title: 'Entrega',
    freelancer_ulid: '01JA0000000000000000000000',
    freelancer_name: 'Freelancer',
    freelancer_timezone: 'America/Rio_Branco',
    dropped_at: NOW,
    client_agreed_at: null,
    appealed_at: null,
    appeal_text: null,
    decision: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    review_checked_at: null,
    ...extra,
  }) as FullDropoutRow;
beforeEach(() => {
  vi.clearAllMocks();
  setClockForTests(NOW, { frozen: true });
  notify.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(repo)) fn.mockReset();
  repo.listCounting.mockResolvedValue([row()]);
  repo.listMine.mockResolvedValue([row()]);
  repo.acceptedInWindow.mockResolvedValue(5);
  repo.agree.mockResolvedValue({ row: row({ client_agreed_at: NOW }), now: NOW });
  repo.appeal.mockResolvedValue({
    row: row({ appealed_at: NOW, appeal_text: 'Meu texto privado' }),
    now: NOW,
  });
  repo.decide.mockResolvedValue({
    row: row({ decision: 'excused', decision_note: 'Nota privada da equipe' }),
    now: NOW,
  });
  repo.saveDecisionNotification.mockImplementation(async (userId, params) => ({
    userId,
    id: 99,
    params,
  }));
});
afterEach(() => setClockForTests(null));

describe('projeções da RN-026', () => {
  it('público devolve somente contagem, janela e alerta', async () => {
    repo.listCounting.mockResolvedValue([
      row({ appeal_text: 'Privado', decision_note: 'Privado' }),
    ]);
    expect(await dropoutsService.publicSummary(44)).toEqual({
      count: 1,
      windowDays: 60,
      alert: false,
    });
  });
  it('titular recebe textos privados e contexto dos aceites; contestada segue contando', async () => {
    repo.listMine.mockResolvedValue([row({ appealed_at: NOW, appeal_text: 'Meu texto privado' })]);
    const result = await dropoutsService.myDropouts(44);
    expect(result).toMatchObject({
      count: 1,
      acceptedInWindow: 5,
      alert: false,
      alertUntil: null,
      items: [{ status: 'counting', canAppeal: false, appealText: 'Meu texto privado' }],
    });
  });
  it.each([
    [{ client_agreed_at: NOW }, 'agreed', null],
    [{ decision: 'excused', decision_note: 'Privado' }, 'excused', null],
    [{ dropped_at: new Date(NOW.getTime() - 61 * DAY) }, 'expired', null],
    [{ decision: 'upheld' }, 'counting', new Date(NOW.getTime() + 60 * DAY).toISOString()],
  ] as const)('status privado trata %j', (extra, status, countsUntil) => {
    expect(toMyDropout(row(extra), NOW)).toMatchObject({ status, countsUntil, canAppeal: false });
  });
  it('admin enxerga contagem atual da conta e titular, em fila antiga primeiro', async () => {
    repo.listAppealed.mockResolvedValue([row({ appealed_at: NOW, appeal_text: 'Texto privado' })]);
    expect(await dropoutsService.listAppealed()).toMatchObject([
      {
        freelancer: { id: 44, ulid: row().freelancer_ulid },
        ownerCount: 1,
        clientAgreed: false,
        appealText: 'Texto privado',
      },
    ]);
  });
  it('usuário inexistente no painel é 404', async () => {
    repo.userIdByUlid.mockResolvedValue(undefined);
    await expect(dropoutsService.listForUser(row().freelancer_ulid)).rejects.toMatchObject({
      statusCode: 404,
      code: 'user_not_found',
    });
  });
});

describe('decisões e privacidade dos avisos', () => {
  it('confirmação devolve apenas fatos da Sala e avisa só o freelancer', async () => {
    repo.agree.mockResolvedValue({
      row: row({
        client_agreed_at: NOW,
        appeal_text: 'Pedido privado',
        decision_note: 'Nota privada',
      }),
      now: NOW,
    });
    const result = await dropoutsService.agree(31, 7);
    // A confirmação é do cliente: a linha do histórico é ação dele (status-history.ts).
    expect(repo.agree).toHaveBeenCalledWith(31, 7, 'user');
    expect(Object.keys(result).sort()).toEqual(['agreeUntil', 'agreedAt', 'at', 'counts']);
    expect(result.counts).toBe(false);
    expect(notify).toHaveBeenCalledWith(
      44,
      expect.objectContaining({
        type: 'dropout_decided',
        data: { dropoutId: 12, decision: 'agreed' },
      }),
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain('Nota privada');
  });
  it('dispensa avisa somente freelancer com a nota; data não inclui texto', async () => {
    expect(
      await dropoutsService.decide(90, 12, 'excuse', 'Nota privada da equipe', '127.0.0.1'),
    ).toMatchObject({ decision: 'excused', status: 'excused' });
    expect(repo.decide).toHaveBeenCalledWith(
      90,
      12,
      'excuse',
      'Nota privada da equipe',
      '127.0.0.1',
    );
    expect(notify).toHaveBeenCalledWith(
      44,
      expect.objectContaining({
        body: expect.stringContaining('Nota privada da equipe'),
        data: { dropoutId: 12, decision: 'excused' },
      }),
    );
  });
  it('manter depois dos 60 dias não promete contagem já vencida', async () => {
    repo.decide.mockResolvedValue({
      row: row({
        dropped_at: new Date(NOW.getTime() - 61 * DAY),
        decision: 'upheld',
        appealed_at: NOW,
      }),
      now: NOW,
    });
    await dropoutsService.decide(90, 12, 'uphold', 'Nota privada da equipe', null);
    expect(notify.mock.calls[0]![1].body).toContain('prazo de 60 dias');
    expect(notify.mock.calls[0]![1].body).toContain('já terminou');
  });
  it('falha no aviso não desfaz confirmação já commitada', async () => {
    repo.saveDecisionNotification.mockRejectedValue(new Error('notice failed'));
    await expect(dropoutsService.agree(31, 7)).resolves.toMatchObject({ counts: false });
  });
  it.each([
    ['not_found', 404, 'dropout_not_found'],
    ['closed', 409, 'dropout_decided_already'],
    ['appeal_required', 422, 'dropout_appeal_required'],
  ])('erro %s vira %s', async (refused, statusCode, code) => {
    repo.decide.mockResolvedValue({ refused });
    await expect(
      dropoutsService.decide(90, 12, 'uphold', 'Nota privada da equipe', null),
    ).rejects.toMatchObject({ statusCode, code });
    expect(notify).not.toHaveBeenCalled();
  });
  it('contestação fechada vira 409, sem aviso', async () => {
    repo.appeal.mockResolvedValue({ refused: 'closed' });
    await expect(dropoutsService.appeal(44, 12, 'Texto privado')).rejects.toMatchObject({
      statusCode: 409,
      code: 'appeal_closed',
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('retomada durável', () => {
  it('hook imediato processa somente o usuário, e propaga falha para caller isolar', async () => {
    repo.reconcileReviews.mockRejectedValue(new Error('db failed'));
    await expect(dropoutsService.afterDropout(44, 31, NOW)).rejects.toThrow('db failed');
    expect(repo.reconcileReviews).toHaveBeenCalledWith(44);
  });
  it('lote nunca excede limite global entre dois titulares e não repete o usuário', async () => {
    repo.findReviewPending.mockResolvedValue([
      row(),
      row({ id: 13 }),
      row({ id: 14, freelancer_id: 45 }),
    ]);
    repo.reconcileReviews
      .mockResolvedValueOnce({ checked: 2, reviewOpened: true })
      .mockResolvedValueOnce({ checked: 1, reviewOpened: false });
    expect(await dropoutsService.reconcilePending(3)).toEqual({ processed: 3, reviewsOpened: 1 });
    expect(repo.reconcileReviews.mock.calls).toEqual([
      [44, 3],
      [45, 1],
    ]);
  });
  it('falha de uma conta não bloqueia a outra, e falha agregada mantém erro observável', async () => {
    repo.findReviewPending.mockResolvedValue([row(), row({ id: 14, freelancer_id: 45 })]);
    repo.reconcileReviews
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce({ checked: 1, reviewOpened: true });
    await expect(dropoutsService.reconcilePending(3)).rejects.toBeInstanceOf(AggregateError);
    expect(repo.reconcileReviews.mock.calls).toEqual([
      [44, 3],
      [45, 3],
    ]);
  });
});
