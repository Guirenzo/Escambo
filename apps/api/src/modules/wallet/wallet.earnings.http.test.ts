import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, routerApp } from '../../test-support/http';
import { HttpError } from '../../utils/http-error';
import { walletRoutes } from './wallet.routes';

const { earnings } = vi.hoisted(() => ({ earnings: { report: vi.fn() } }));
vi.mock('./wallet.earnings.service', () => ({ earningsService: earnings }));

const app = routerApp('/api/wallet', walletRoutes);

/**
 * GET /api/wallet/earnings (RF-082): exige login, o dono é sempre o do token e a query passa pela
 * validação antes do service (mockado aqui).
 */
describe('GET /api/wallet/earnings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sem login é 401 e o service nem é chamado', async () => {
    const res = await request(app).get('/api/wallet/earnings').expect(401);
    expect(res.body.error).toBe('missing_token');
    expect(earnings.report).not.toHaveBeenCalled();
  });

  it('pede os ganhos de quem está logado, com o agrupamento padrão por mês', async () => {
    earnings.report.mockResolvedValue({ from: '2025-11-01', to: '2026-10-19' });

    const res = await request(app).get('/api/wallet/earnings').set(bearer(7)).expect(200);

    expect(res.body).toEqual({ from: '2025-11-01', to: '2026-10-19' });
    expect(earnings.report).toHaveBeenCalledExactlyOnceWith(7, { granularity: 'month' });
  });

  it('período e agrupamento chegam validados', async () => {
    earnings.report.mockResolvedValue({});

    await request(app)
      .get('/api/wallet/earnings?from=2026-10-01&to=2026-10-31&granularity=week')
      .set(bearer(9, 'freelancer'))
      .expect(200);

    expect(earnings.report).toHaveBeenCalledWith(9, {
      from: '2026-10-01',
      to: '2026-10-31',
      granularity: 'week',
    });
  });

  it('dia inexistente ou agrupamento fora da lista é 422 no campo', async () => {
    const bad = await request(app)
      .get('/api/wallet/earnings?from=2026-02-30&granularity=year')
      .set(bearer(7))
      .expect(422);

    expect(bad.body.error).toBe('validation_error');
    expect(bad.body.details.from).toEqual(['Informe um dia válido no formato AAAA-MM-DD']);
    expect(bad.body.details).toHaveProperty('granularity');
    expect(earnings.report).not.toHaveBeenCalled();
  });

  it('a recusa do service (período invertido) sai no formato padrão', async () => {
    earnings.report.mockRejectedValue(
      new HttpError(
        400,
        'Período inválido: a data inicial precisa ser até a final',
        'invalid_range',
      ),
    );

    const res = await request(app)
      .get('/api/wallet/earnings?from=2026-10-02&to=2026-10-01')
      .set(bearer(7))
      .expect(400);

    expect(res.body).toEqual({
      error: 'invalid_range',
      message: 'Período inválido: a data inicial precisa ser até a final',
    });
  });
});
