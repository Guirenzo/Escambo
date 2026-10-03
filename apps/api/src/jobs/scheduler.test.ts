import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registry } from '../config/metrics';
import { JOBS, runAllJobs } from './scheduler';

const { captureError, runDeadlineReminders } = vi.hoisted(() => ({
  captureError: vi.fn(),
  runDeadlineReminders: vi.fn(),
}));
vi.mock('../config/sentry', () => ({ captureError }));
// O job dos lembretes tem o próprio teste (deadline-reminders.test): aqui importa onde ele entra.
vi.mock('./deadline-reminders', () => ({ runDeadlineReminders }));

/** A linha de uma série no /metrics, ou undefined. */
async function sample(series: string): Promise<string | undefined> {
  const body = await registry.metrics();
  return body.split('\n').find((line) => line.startsWith(series));
}

describe('agendador de jobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('todo job de JOBS já tem as duas séries em zero antes da primeira rodada', async () => {
    expect(JOBS.length).toBeGreaterThan(0);
    for (const { name } of JOBS) {
      expect(await sample(`escambo_job_runs_total{job_name="${name}",outcome="ok"}`)).toMatch(
        / 0$/,
      );
      expect(await sample(`escambo_job_runs_total{job_name="${name}",outcome="error"}`)).toMatch(
        / 0$/,
      );
    }
  });

  it('a ordem da rodada: o reparo antes de quem lê os prazos, as sanções antes dos lembretes e os lembretes antes do resumo diário', () => {
    expect(JOBS.map((j) => j.name)).toEqual([
      'repair-deadlines',
      'tacit-approval',
      'expire-proposals',
      'overdue-contracts',
      'deadline-reminders',
      'daily-digest',
      'moderation-sla-report',
      'quiet-push-summary',
      'expire-deposits',
      'expire-exports',
      'purge-attachments',
      'purge-quarantine',
      'saved-search-alerts',
      'purge-push-subscriptions',
    ]);
  });

  it('o job dos lembretes roda com o relógio do fluxo de prazos (sem hora fixa)', async () => {
    const result = { zones: [] };
    runDeadlineReminders.mockResolvedValue(result);
    const job = JOBS.find((j) => j.name === 'deadline-reminders');

    expect(await job!.run()).toBe(result);
    expect(runDeadlineReminders.mock.calls).toEqual([[]]);
  });

  it('conta o resultado e a duração de cada job; a falha de um não para os outros e vai ao Sentry', async () => {
    const boom = new Error('SMTP fora');
    const order: string[] = [];
    await runAllJobs([
      {
        name: 't-ruim',
        run: async () => {
          order.push('t-ruim');
          throw boom;
        },
      },
      {
        name: 't-bom',
        run: async () => {
          order.push('t-bom');
          return 1;
        },
      },
    ]);

    expect(order).toEqual(['t-ruim', 't-bom']);
    expect(await sample('escambo_job_runs_total{job_name="t-ruim",outcome="error"}')).toMatch(
      / 1$/,
    );
    expect(await sample('escambo_job_runs_total{job_name="t-bom",outcome="ok"}')).toMatch(/ 1$/);
    expect(await sample('escambo_job_runs_total{job_name="t-ruim",outcome="ok"}')).toBeUndefined();
    expect(await sample('escambo_job_duration_seconds_count{job_name="t-ruim"}')).toMatch(/ 1$/);
    expect(await sample('escambo_job_duration_seconds_count{job_name="t-bom"}')).toMatch(/ 1$/);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(boom);
  });

  it('não sobrepõe rodadas: a segunda chamada sai sem rodar nada enquanto a primeira não termina', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(async () => {
      await gate;
    });
    const first = runAllJobs([{ name: 't-lento', run: slow }]);
    await runAllJobs([{ name: 't-lento', run: slow }]);
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await first;
    await runAllJobs([{ name: 't-lento', run: slow }]);
    expect(slow).toHaveBeenCalledTimes(2);
  });
});
