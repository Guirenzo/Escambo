import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/settings/settings.service', () => ({
  settingsService: { maintenanceMode: vi.fn() },
}));

import { env } from '../config/env';
import { settingsService } from '../modules/settings/settings.service';
import { maintenanceGate, RETRY_AFTER_SECONDS } from './maintenance';

const mode = vi.mocked(settingsService.maintenanceMode);

function run(path: string, authorization?: string) {
  const req = { path, headers: authorization ? { authorization } : {} } as never;
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => void (headers[k] = v) } as never;
  return new Promise<{ err: unknown; headers: Record<string, string> }>((resolve) => {
    maintenanceGate(req, res, (err?: unknown) => resolve({ err, headers }));
  });
}
const token = (role: string) => `Bearer ${jwt.sign({ sub: 'u', uid: 1, role }, env.JWT_SECRET)}`;

describe('maintenanceGate (ADR 33)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('desligado: passa tudo sem olhar o token', async () => {
    mode.mockResolvedValue(false);
    expect((await run('/services')).err).toBeUndefined();
    expect((await run('/contracts', 'Bearer lixo')).err).toBeUndefined();
  });

  it('ligado: 503 com Retry-After para quem não é admin', async () => {
    mode.mockResolvedValue(true);
    const anon = await run('/services');
    expect(anon.err).toMatchObject({ statusCode: 503, code: 'maintenance' });
    expect(anon.headers['Retry-After']).toBe(String(RETRY_AFTER_SECONDS));
    expect((await run('/contracts', token('client'))).err).toMatchObject({ statusCode: 503 });
    expect((await run('/contracts', 'Bearer invalido')).err).toMatchObject({ statusCode: 503 });
  });

  it('ligado: admin passa em qualquer rota; health, auth, públicos e painel passam sem token', async () => {
    mode.mockResolvedValue(true);
    expect((await run('/services', token('admin'))).err).toBeUndefined();
    for (const p of [
      '/health',
      '/health/live',
      '/auth/login',
      '/auth/refresh',
      '/settings/public',
      '/admin/settings',
      '/admin',
    ]) {
      expect((await run(p)).err, p).toBeUndefined();
    }
    expect((await run('/settings/publico')).err).toMatchObject({ statusCode: 503 });
  });

  it('erro ao ler a chave sobe para o error handler (não derruba a requisição em silêncio)', async () => {
    mode.mockRejectedValue(new Error('db'));
    expect((await run('/services')).err).toBeInstanceOf(Error);
  });
});
