import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registry } from '../config/metrics';
import { JOBS, runAllJobs } from './scheduler';

const { captureError } = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock('../config/sentry', () => ({ captureError }));

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
