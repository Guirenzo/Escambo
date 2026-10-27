import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('./account-access.repository');
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
import { fakeDb } from '../../test-support/fake-db';
import { accountAccessRepository } from './account-access.repository';

beforeEach(() => fakeDb.reset());
describe('consulta atual da identidade', () => {
  it('vincula uid e sub na mesma consulta e carrega o papel/status atuais', async () => {
    const row = {
      id: 7,
      ulid: 'ulid-7',
      role: 'client',
      status: 'suspended',
      deleted_at: null,
      email_verified_at: null,
    };
    fakeDb.reply([row]);
    expect(
      await accountAccessRepository.findCurrent({ uid: 7, sub: 'ulid-7', role: 'admin' }),
    ).toBe(row);
    expect(fakeDb.calls).toEqual([
      {
        sql: 'SELECT id, ulid, role, status, deleted_at, email_verified_at FROM users WHERE id = :uid AND ulid = :sub LIMIT 1',
        params: { uid: 7, sub: 'ulid-7' },
      },
    ]);
  });
  it('nenhuma correspondência continua ausente', async () => {
    fakeDb.reply([]);
    expect(
      await accountAccessRepository.findCurrent({ uid: 7, sub: 'other', role: 'client' }),
    ).toBeUndefined();
  });
});
