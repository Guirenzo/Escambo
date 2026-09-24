import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/mail/mail.service', () => ({
  mailService: { enabled: vi.fn(), deliver: vi.fn() },
}));
vi.mock('../modules/settings/settings.service', () => ({
  settingsService: { flag: vi.fn(), number: vi.fn() },
}));
vi.mock('../modules/settings/settings.repository', () => ({
  settingsRepository: { get: vi.fn(), setIf: vi.fn(), set: vi.fn(), list: vi.fn() },
}));
vi.mock('../modules/auth/auth.repository', () => ({
  authRepository: { listAdmins: vi.fn() },
}));
vi.mock('../modules/reports/moderation.health', () => ({
  moderationHealthService: { history: vi.fn() },
  openQueue: vi.fn(),
}));

import { env } from '../config/env';
import { authRepository } from '../modules/auth/auth.repository';
import { mailService } from '../modules/mail/mail.service';
import { moderationHealthService, openQueue } from '../modules/reports/moderation.health';
import { REPORT_STATE_KEY } from '../modules/reports/moderation.sla-state';
import { settingsRepository } from '../modules/settings/settings.repository';
import { settingsService } from '../modules/settings/settings.service';
import { runModerationSlaReport } from './moderation-sla-report';

const mail = vi.mocked(mailService);
const settings = vi.mocked(settingsService);
const repo = vi.mocked(settingsRepository);
const auth = vi.mocked(authRepository);
const health = vi.mocked(moderationHealthService);
const queue = vi.mocked(openQueue);

// 09:00 em Brasília, depois das 8h do DIGEST_HOUR padrão.
const MANHA = new Date('2026-09-24T12:00:00Z');
const CEDO = new Date('2026-09-24T10:00:00Z');

const dia = (medianHours: number | null) => ({
  day: '2026-09-23',
  received: 3,
  flagged: 0,
  actioned: 2,
  dismissed: 0,
  medianHours,
});
const filaVazia = {
  pending: 0,
  oldest: null,
  automatic: 0,
  reviews: 0,
  oldestContent: null,
  overSla: 0,
  overSlaItems: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mail.enabled.mockReturnValue(true);
  settings.flag.mockResolvedValue(true);
  settings.number.mockResolvedValue(24);
  repo.get.mockResolvedValue(null);
  repo.setIf.mockResolvedValue(true);
  repo.list.mockResolvedValue([]);
  auth.listAdmins.mockResolvedValue([
    { id: 1, email: 'admin@escambo.test' },
    { id: 2, email: 'outra@escambo.test' },
  ]);
  health.history.mockResolvedValue({
    history: [dia(6), { ...dia(null), day: '2026-09-24' }],
    slaHours: 24,
  });
  queue.mockResolvedValue(filaVazia);
  mail.deliver.mockResolvedValue({ id: 11, delivered: true });
});

/** Relatório diário da meta da moderação (ADR 55): quando roda, a trava do dia e o envio. */
describe('runModerationSlaReport', () => {
  it('não faz nada com e-mail desligado, com a chave desligada ou antes da hora', async () => {
    mail.enabled.mockReturnValue(false);
    expect((await runModerationSlaReport(MANHA)).skipped).toBe('mail_off');
    expect(settings.flag).not.toHaveBeenCalled();

    mail.enabled.mockReturnValue(true);
    settings.flag.mockResolvedValue(false);
    expect((await runModerationSlaReport(MANHA)).skipped).toBe('disabled');

    settings.flag.mockResolvedValue(true);
    expect((await runModerationSlaReport(CEDO)).skipped).toBe('before_hour');
    expect(repo.get).not.toHaveBeenCalled();
    expect(health.history).not.toHaveBeenCalled();
    // Na hora cheia do DIGEST_HOUR (08:00 em Brasília = 11:00Z) já roda.
    expect((await runModerationSlaReport(new Date('2026-09-24T11:00:00Z'))).skipped).toBeNull();
  });

  it('dia já conferido: não consulta nem grava', async () => {
    repo.get.mockResolvedValue(
      JSON.stringify({
        day: '2026-09-24',
        at: '2026-09-24T11:00:00.000Z',
        breached: false,
        recipients: 1,
      }),
    );
    expect((await runModerationSlaReport(MANHA)).skipped).toBe('already_today');
    expect(health.history).not.toHaveBeenCalled();
    expect(repo.setIf).not.toHaveBeenCalled();
  });

  it('meta dentro: grava a marca do dia e não manda nada', async () => {
    const r = await runModerationSlaReport(MANHA);
    expect(r).toMatchObject({
      skipped: null,
      breached: false,
      slow: false,
      waiting: false,
      recipients: 2,
      delivered: 0,
      attempts: 0,
      provider: env.MAIL_PROVIDER,
    });
    expect(health.history).toHaveBeenCalledWith(1, MANHA);
    expect(queue).toHaveBeenCalledWith(MANHA, 24);
    expect(repo.setIf).toHaveBeenCalledWith(
      REPORT_STATE_KEY,
      JSON.stringify({
        day: '2026-09-24',
        at: MANHA.toISOString(),
        breached: false,
        slaHours: 24,
        recipients: 2,
        delivered: 0,
        attempts: 0,
      }),
      null,
    );
    expect(mail.deliver).not.toHaveBeenCalled();
    expect(repo.set).not.toHaveBeenCalled();
  });

  it('meta estourada ontem: a trava vai antes do envio, cada admin recebe, e as entregas aceitas ficam gravadas', async () => {
    health.history.mockResolvedValue({ history: [dia(30)], slaHours: 24 });
    mail.deliver
      .mockResolvedValueOnce({ id: 11, delivered: true })
      .mockResolvedValueOnce({ id: 12, delivered: false });
    const r = await runModerationSlaReport(MANHA);
    expect(r).toMatchObject({
      breached: true,
      slow: true,
      waiting: false,
      recipients: 2,
      delivered: 1,
      attempts: 1,
    });
    expect(repo.setIf).toHaveBeenCalledBefore(mail.deliver);
    expect(mail.deliver).toHaveBeenCalledTimes(2);
    expect(mail.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        to: 'admin@escambo.test',
        template: 'moderation_report',
        vars: expect.objectContaining({
          title: 'Moderação: ontem (23/09) a fila passou da meta de 24 h',
          paragraphs: expect.arrayContaining([expect.stringContaining('30,0 h na mediana')]),
          link: expect.stringContaining('/admin#health-title'),
        }),
      }),
    );
    // A entrega aceita vai para a marca na hora, encadeada na trava; a recusada não grava nada.
    expect(repo.setIf).toHaveBeenCalledTimes(2);
    const [, claimed] = repo.setIf.mock.calls[0]!;
    const [key, updated, expected] = repo.setIf.mock.calls[1]!;
    expect(key).toBe(REPORT_STATE_KEY);
    expect(expected).toBe(claimed);
    expect(JSON.parse(updated)).toMatchObject({ attempts: 1, breached: true, delivered: 1 });
    expect(repo.set).not.toHaveBeenCalled();
  });

  it('fila passou da meta agora: estoura mesmo sem decisão ontem; meta alterada hoje entra no texto', async () => {
    health.history.mockResolvedValue({ history: [dia(null)], slaHours: 24 });
    queue.mockResolvedValue({
      ...filaVazia,
      pending: 2,
      overSla: 2,
      overSlaItems: 2,
      oldestContent: new Date('2026-09-22T12:00:00Z'),
    });
    repo.list.mockResolvedValue([
      {
        key_name: 'moderation_sla_hours',
        value: '24',
        type: 'integer',
        updated_at: new Date('2026-09-24T10:30:00Z'),
        updated_by_email: 'admin@escambo.test',
      },
    ] as never);
    const r = await runModerationSlaReport(MANHA);
    expect(r).toMatchObject({ breached: true, slow: false, waiting: true, delivered: 2 });
    const vars = mail.deliver.mock.calls[0]![0].vars as { paragraphs: string[] };
    expect(vars.paragraphs).toContain('A meta de 24 h foi alterada hoje às 07:30.');
  });

  it('meta alterada ontem não vira aviso', async () => {
    health.history.mockResolvedValue({ history: [dia(30)], slaHours: 24 });
    repo.list.mockResolvedValue([
      {
        key_name: 'moderation_sla_hours',
        value: '24',
        type: 'integer',
        updated_at: new Date('2026-09-23T20:00:00Z'),
        updated_by_email: null,
      },
    ] as never);
    await runModerationSlaReport(MANHA);
    const vars = mail.deliver.mock.calls[0]![0].vars as { paragraphs: string[] };
    expect(vars.paragraphs.some((p) => p.includes('foi alterada hoje'))).toBe(false);
  });

  it('a marca mudou por fora no meio do envio: para de mandar', async () => {
    health.history.mockResolvedValue({ history: [dia(30)], slaHours: 24 });
    repo.setIf.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const r = await runModerationSlaReport(MANHA);
    expect(mail.deliver).toHaveBeenCalledTimes(1);
    expect(r.delivered).toBe(1);
  });

  it('outra instância gravou a marca primeiro: desiste sem enviar', async () => {
    health.history.mockResolvedValue({ history: [dia(30)], slaHours: 24 });
    repo.setIf.mockResolvedValue(false);
    expect((await runModerationSlaReport(MANHA)).skipped).toBe('claimed_elsewhere');
    expect(mail.deliver).not.toHaveBeenCalled();
  });

  it('meta estourada e nenhum admin no banco: grava a marca sem tentativa e avisa no log', async () => {
    health.history.mockResolvedValue({ history: [dia(30)], slaHours: 24 });
    auth.listAdmins.mockResolvedValue([]);
    const r = await runModerationSlaReport(MANHA);
    expect(r).toMatchObject({
      skipped: null,
      breached: true,
      recipients: 0,
      delivered: 0,
      attempts: 0,
    });
    expect(mail.deliver).not.toHaveBeenCalled();
    expect(JSON.parse(repo.setIf.mock.calls[0]![1])).toMatchObject({ recipients: 0, attempts: 0 });
  });

  it('nova tentativa no mesmo dia: passa o JSON antigo como esperado do compare-and-set e soma a tentativa', async () => {
    const antes = JSON.stringify({
      day: '2026-09-24',
      at: '2026-09-24T11:00:00.000Z',
      breached: true,
      slaHours: 24,
      recipients: 2,
      delivered: 0,
      attempts: 1,
    });
    repo.get.mockResolvedValue(antes);
    health.history.mockResolvedValue({ history: [dia(30)], slaHours: 24 });
    const r = await runModerationSlaReport(new Date('2026-09-24T12:30:00Z'));
    expect(r.attempts).toBe(2);
    expect(repo.setIf).toHaveBeenCalledWith(
      REPORT_STATE_KEY,
      expect.stringContaining('"attempts":2'),
      antes,
    );
  });
});
