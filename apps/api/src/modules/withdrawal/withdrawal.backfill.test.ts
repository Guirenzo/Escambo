import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn() },
  repo: { listStoredToSeal: vi.fn(), replaceStoredDestination: vi.fn() },
}));
vi.mock('../../config/logger', () => ({ logger: h.logger }));
vi.mock('./withdrawal.repository', () => ({ withdrawalRepository: h.repo }));

import { fieldKeyId, openField, sealField, setFieldKeysForTests } from '../../utils/field-crypto';
import { sealStoredWithdrawals } from './withdrawal.backfill';
import type { Destination } from './withdrawal.fields';

const KEY = Buffer.alloc(32, 0x71).toString('base64');
const OLD = Buffer.alloc(32, 0x72).toString('base64');
const GONE = Buffer.alloc(32, 0x73).toString('base64');
const PREFIX = `enc:v1:${fieldKeyId(Buffer.from(KEY, 'base64'))}:`;

const row = (id: number, o: Record<string, string | null> = {}) => ({
  id,
  pix_key: null,
  bank_name: null,
  bank_agency: null,
  bank_account: null,
  ...o,
});

const plain = (stored: string | null): string | null => {
  if (stored === null) return null;
  const opened = openField(stored);
  return opened.ok ? opened.value : `falhou: ${opened.reason}`;
};

/** As regravações pedidas: [id, de, para]. */
const replaced = () =>
  h.repo.replaceStoredDestination.mock.calls as [number, Destination, Destination][];

beforeEach(() => {
  vi.resetAllMocks();
  setFieldKeysForTests({ current: KEY });
  h.repo.listStoredToSeal.mockResolvedValue([]);
  h.repo.replaceStoredDestination.mockResolvedValue(true);
});
afterEach(() => setFieldKeysForTests(null));

/**
 * fields:encrypt (RNF-017) com o repository mockado: o que é lido, em que lotes, o que é regravado,
 * e o que fica como estava. Se o SQL acha as linhas certas no MySQL é da integração.
 */
describe('sealStoredWithdrawals (fields:encrypt)', () => {
  it('sem a chave, recusa antes de ler o banco', async () => {
    setFieldKeysForTests({});

    await expect(sealStoredWithdrawals()).rejects.toThrow('FIELD_ENCRYPTION_KEY não configurada');
    expect(h.repo.listStoredToSeal).not.toHaveBeenCalled();
    expect(h.repo.replaceStoredDestination).not.toHaveBeenCalled();
  });

  it('nada a cifrar: uma consulta, nada regravado (rodar de novo é assim)', async () => {
    expect(await sealStoredWithdrawals()).toEqual({ checked: 0, sealed: 0, unreadable: 0 });
    expect(h.repo.listStoredToSeal.mock.calls).toEqual([[0, PREFIX, 200]]);
    expect(h.repo.replaceStoredDestination).not.toHaveBeenCalled();
  });

  it('cifra o texto puro em lotes pelo id, cada saque num UPDATE condicionado ao que foi lido', async () => {
    h.repo.listStoredToSeal
      .mockResolvedValueOnce([row(3, { pix_key: 'a@pix' }), row(8, { pix_key: 'b@pix' })])
      .mockResolvedValueOnce([
        row(12, { bank_name: 'Banco do Brasil', bank_agency: '0001', bank_account: '12-3' }),
      ]);

    expect(await sealStoredWithdrawals(2)).toEqual({ checked: 3, sealed: 3, unreadable: 0 });

    // O lote seguinte começa depois do último id lido; o lote incompleto encerra.
    expect(h.repo.listStoredToSeal.mock.calls).toEqual([
      [0, PREFIX, 2],
      [8, PREFIX, 2],
    ]);
    const calls = replaced();
    expect(calls.map(([id]) => id)).toEqual([3, 8, 12]);
    expect(calls[0]![1]).toEqual({
      pixKey: 'a@pix',
      bankName: null,
      bankAgency: null,
      bankAccount: null,
    });
    expect(calls[0]![2].pixKey!.startsWith(PREFIX)).toBe(true);
    expect(plain(calls[0]![2].pixKey!)).toBe('a@pix');
    expect(calls[0]![2]).toMatchObject({ bankName: null, bankAgency: null, bankAccount: null });
    const bank = calls[2]![2];
    expect([bank.bankName, bank.bankAgency, bank.bankAccount].map(plain)).toEqual([
      'Banco do Brasil',
      '0001',
      '12-3',
    ]);
    expect(bank.pixKey).toBeNull();
  });

  it('lote cheio pede o próximo, mesmo que venha vazio', async () => {
    h.repo.listStoredToSeal.mockResolvedValueOnce([row(1, { pix_key: 'x' })]);

    expect(await sealStoredWithdrawals(1)).toEqual({ checked: 1, sealed: 1, unreadable: 0 });
    expect(h.repo.listStoredToSeal.mock.calls).toEqual([
      [0, PREFIX, 1],
      [1, PREFIX, 1],
    ]);
  });

  it('rotação: o que foi cifrado com uma chave antiga é regravado com a atual', async () => {
    setFieldKeysForTests({ current: OLD });
    const withOld = sealField('rotacao@pix');
    setFieldKeysForTests({ current: KEY, old: [OLD] });
    h.repo.listStoredToSeal.mockResolvedValueOnce([row(4, { pix_key: withOld })]);

    expect(await sealStoredWithdrawals()).toEqual({ checked: 1, sealed: 1, unreadable: 0 });
    const [, from, to] = replaced()[0]!;
    expect(from.pixKey).toBe(withOld);
    expect(to.pixKey!.startsWith(PREFIX)).toBe(true);
    expect(plain(to.pixKey!)).toBe('rotacao@pix');
  });

  it('valor que não decifra fica como está, é contado e registrado sem o valor; o resto do saque é cifrado', async () => {
    setFieldKeysForTests({ current: GONE });
    const lost = sealField('0001');
    setFieldKeysForTests({ current: KEY });
    h.repo.listStoredToSeal.mockResolvedValueOnce([
      row(6, { bank_name: 'Itaú', bank_agency: lost, bank_account: '55-1' }),
      row(7, { pix_key: 'enc:v1:quebrado' }),
    ]);

    expect(await sealStoredWithdrawals()).toEqual({ checked: 2, sealed: 1, unreadable: 2 });

    // O saque 7 não tem nada que dê para cifrar: nem é regravado.
    const calls = replaced();
    expect(calls.map(([id]) => id)).toEqual([6]);
    const to = calls[0]![2];
    expect(to.bankAgency).toBe(lost);
    expect(plain(to.bankName)).toBe('Itaú');
    expect(plain(to.bankAccount)).toBe('55-1');

    expect(h.logger.warn.mock.calls.map(([context]) => context)).toEqual([
      { withdrawalId: 6, failed: [{ column: 'bank_agency', reason: 'unknown_key' }] },
      { withdrawalId: 7, failed: [{ column: 'pix_key', reason: 'malformed' }] },
    ]);
    const logged = JSON.stringify(h.logger.warn.mock.calls);
    expect(logged).not.toContain(lost);
    expect(logged).not.toContain('Itaú');
  });

  it('o que já está com a chave atual não é regravado, e a corrida perdida não conta como cifrado', async () => {
    const current = sealField('ja@pix');
    h.repo.listStoredToSeal.mockResolvedValueOnce([
      row(1, { pix_key: current }),
      row(2, { pix_key: 'corrida@pix' }),
    ]);
    // Outra rodada cifrou o saque 2 entre a leitura e o UPDATE.
    h.repo.replaceStoredDestination.mockResolvedValueOnce(false);

    expect(await sealStoredWithdrawals()).toEqual({ checked: 2, sealed: 0, unreadable: 0 });
    expect(replaced().map(([id]) => id)).toEqual([2]);
  });
});
