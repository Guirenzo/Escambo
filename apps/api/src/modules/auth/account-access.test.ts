import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blocklist } from '../../config/blocklist';
import { accountAccessRepository, type AccountAccessRow } from './account-access.repository';
import {
  assertBusinessWrite,
  currentAccount,
  suspendedRequestAllowed,
  validateAccessIdentity,
} from './account-access';

const lookup = vi.mocked(accountAccessRepository.findCurrent);
const identity = { uid: 7, sub: 'ulid-7', role: 'admin' };
const row = (extra: Partial<Omit<AccountAccessRow, 'constructor'>> = {}) =>
  ({
    id: 7,
    ulid: 'ulid-7',
    role: 'client',
    status: 'active',
    deleted_at: null,
    ...extra,
  }) as AccountAccessRow;

beforeEach(() => {
  lookup.mockReset().mockResolvedValue(row());
  blocklist.delete(7);
});

describe('autoridade atual da conta', () => {
  it('usa papel/status do banco, mesmo com JWT admin e cache local banido', async () => {
    blocklist.add(7);
    expect(await currentAccount(identity)).toEqual({
      uid: 7,
      sub: 'ulid-7',
      role: 'client',
      status: 'active',
    });
    expect(lookup).toHaveBeenCalledWith(identity);
    blocklist.delete(7);
  });
  it('consulta novamente após suspensão e reativação sem exigir token novo', async () => {
    lookup.mockResolvedValueOnce(row({ status: 'suspended' })).mockResolvedValueOnce(row());
    const suspended = await currentAccount(identity);
    expect(suspended.status).toBe('suspended');
    expect(() => assertBusinessWrite(suspended)).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'account_suspended' }),
    );
    expect(() => assertBusinessWrite({ ...suspended, status: 'active' })).not.toThrow();
    expect((await currentAccount(identity)).status).toBe('active');
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ status: 'banned' }, 'account_blocked'],
    [{ deleted_at: new Date() }, 'account_deleted'],
  ] as const)('nega leitura para %j', async (extra, code) => {
    lookup.mockResolvedValue(row(extra));
    await expect(currentAccount(identity)).rejects.toMatchObject({ statusCode: 403, code });
  });
  it('identidade sem correspondência não ganha acesso', async () => {
    lookup.mockResolvedValue(undefined);
    await expect(currentAccount(identity)).rejects.toMatchObject({
      statusCode: 401,
      code: 'invalid_token',
    });
  });
  it('falha de consulta fecha o acesso com erro recuperável', async () => {
    lookup.mockRejectedValue(new Error('db down'));
    await expect(currentAccount(identity)).rejects.toMatchObject({
      statusCode: 503,
      code: 'account_access_unavailable',
    });
  });
  it.each([{ status: 'unknown' }, { role: 'unknown' }])(
    'estado inválido no banco fecha acesso: %j',
    async (extra) => {
      lookup.mockResolvedValue(row(extra as Partial<AccountAccessRow>));
      await expect(currentAccount(identity)).rejects.toMatchObject({ statusCode: 503 });
    },
  );
});

describe('identificadores assinados', () => {
  it('seleciona apenas os campos de identidade', () => {
    expect(validateAccessIdentity({ ...identity, status: 'active', extra: 'ignored' })).toEqual(
      identity,
    );
  });
  it.each([
    null,
    'jwt',
    {},
    { ...identity, uid: '7' },
    { ...identity, uid: -1 },
    { ...identity, uid: 0 },
    { ...identity, uid: 1.5 },
    { ...identity, uid: Number.MAX_SAFE_INTEGER + 1 },
    { ...identity, sub: '' },
    { ...identity, sub: ' ' },
    { ...identity, role: 'owner' },
  ])('nega identidade malformada: %j', (claims) => {
    expect(() => validateAccessIdentity(claims)).toThrow(
      expect.objectContaining({ statusCode: 401, code: 'invalid_token' }),
    );
  });
});

describe('matriz somente leitura', () => {
  it.each(['GET', 'HEAD'])('permite %s em dados autenticados', (method) => {
    expect(suspendedRequestAllowed(method, '/api/contracts/42?download=true')).toBe(true);
  });
  it.each([
    ['POST', '/api/auth/logout-all'],
    ['POST', '/api/auth/change-password'],
    ['POST', '/api/lgpd/consents'],
    ['POST', '/api/lgpd/deletion-requests/'],
    ['POST', '/api/lgpd/export-requests'],
    ['POST', '/api/support/tickets'],
    ['POST', '/api/support/tickets/21/messages?source=notice'],
    ['POST', '/api/support/tickets/21/close/'],
    ['POST', '/api/moderation/removals/21/appeal'],
    ['POST', '/api/profiles/me/dropouts/12/appeal'],
    // Registro de leitura do chat (RF-059): não é conteúdo novo.
    ['POST', '/api/messaging/contracts/42/read'],
    ['POST', '/api/messaging/contracts/42/read/?source=sala'],
    ['DELETE', '/api/notifications/push'],
    // Desistir da troca de e-mail pendente só protege a conta (RF-017).
    ['DELETE', '/api/auth/change-email'],
    ['DELETE', '/api/auth/change-email/'],
  ])('preserva exceção explícita %s %s', (method, path) => {
    expect(suspendedRequestAllowed(method!, path!)).toBe(true);
  });
  it.each([
    ['GET', '/api/admin'],
    ['HEAD', '/api/ADMIN/metrics/'],
    ['POST', '/api/contracts'],
    ['POST', '/api/disputes'],
    ['POST', '/api/reports'],
    ['POST', '/api/contracts/42/dropout-agreement'],
    ['POST', '/api/notifications/read-all'],
    ['POST', '/api/notifications/push'],
    ['PUT', '/api/notifications/preferences'],
    ['PATCH', '/api/profiles/me'],
    ['DELETE', '/api/services/3'],
    ['DELETE', '/api/notifications/push/test'],
    ['POST', '/api/lgpd/consents/extra'],
    ['POST', '/api/auth/change-password/extra'],
    ['PUT', '/api/auth/change-password'],
    ['POST', '/api/moderation/removals/21/appeal/extra'],
    ['POST', '/api/profiles/me/dropouts/12/agree'],
    ['POST', '/api/support/tickets/21/messages/extra'],
    ['POST', '/api/support/tickets/21/reopen'],
    ['PATCH', '/api/support/tickets/21'],
    ['POST', '/api/admin/support/tickets/21/messages'],
    ['POST', '/api/messaging/contracts/42'],
    ['POST', '/api/messaging/contracts/42/attachments'],
    ['POST', '/api/messaging/contracts/42/read/extra'],
    ['POST', '/api/messaging/contracts/abc/read'],
    // Pedir a troca de e-mail ou mudar o telefone é alteração de cadastro: fica para depois.
    ['POST', '/api/auth/change-email'],
    ['PUT', '/api/auth/phone'],
    ['DELETE', '/api/auth/change-email/extra'],
  ])('nega ação de negócio ou caminho fora da exceção %s %s', (method, path) => {
    expect(suspendedRequestAllowed(method!, path!)).toBe(false);
  });
});
