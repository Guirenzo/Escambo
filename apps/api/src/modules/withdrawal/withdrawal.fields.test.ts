import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../config/logger', () => ({ logger: h.logger }));

import {
  FIELD_UNAVAILABLE,
  openField,
  sealField,
  setFieldKeysForTests,
} from '../../utils/field-crypto';
import { DESTINATION_COLUMNS, openDestination, sealDestination } from './withdrawal.fields';
import { createWithdrawalSchema } from './withdrawal.schema';

const KEY = Buffer.alloc(32, 0x5c).toString('base64');
const OTHER = Buffer.alloc(32, 0x3e).toString('base64');

const plain = (sealed: string | null): string | null => {
  if (sealed === null) return null;
  const opened = openField(sealed);
  return opened.ok ? opened.value : `falhou: ${opened.reason}`;
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => setFieldKeysForTests(null));

/**
 * Destino do saque em repouso (RNF-017): o que vai para o INSERT, o que sai da leitura, e se o maior
 * destino que a API aceita cabe cifrado nas colunas da migration 0039.
 */
describe('destino do saque cifrado (RNF-017)', () => {
  const pixDestination = {
    pixKey: 'chave@escambo.test',
    bankName: null,
    bankAgency: null,
    bankAccount: null,
  };
  const bankDestination = {
    pixKey: null,
    bankName: 'Banco do Brasil',
    bankAgency: '0001',
    bankAccount: '12345-6',
  };

  it('com a chave, cada campo preenchido vai cifrado e os nulos continuam nulos', () => {
    setFieldKeysForTests({ current: KEY });

    const pix = sealDestination(pixDestination);
    expect(pix.pixKey).toMatch(/^enc:v1:/);
    expect(pix.pixKey).not.toContain('chave@escambo.test');
    expect(plain(pix.pixKey)).toBe('chave@escambo.test');
    expect([pix.bankName, pix.bankAgency, pix.bankAccount]).toEqual([null, null, null]);

    const bank = sealDestination(bankDestination);
    expect(bank.pixKey).toBeNull();
    for (const field of ['bankName', 'bankAgency', 'bankAccount'] as const) {
      expect(bank[field]).toMatch(/^enc:v1:/);
      expect(plain(bank[field])).toBe(bankDestination[field]);
    }
  });

  it('sem a chave, o destino vai como veio (texto puro, como antes)', () => {
    expect(sealDestination(bankDestination)).toEqual(bankDestination);
    expect(sealDestination(pixDestination)).toEqual(pixDestination);
  });

  it('a leitura decifra o destino, devolve uma cópia e não mexe no resto da linha', () => {
    setFieldKeysForTests({ current: KEY });
    const row = {
      id: 9,
      amount: '50.00',
      pix_key: sealField('chave@escambo.test'),
      bank_name: null,
      bank_agency: null,
      bank_account: null,
    };
    const stored = { ...row };

    const out = openDestination(row);

    expect(out).toEqual({ ...row, pix_key: 'chave@escambo.test' });
    expect(row).toEqual(stored); // a linha lida não muda
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('linha antiga em texto puro continua legível, com ou sem chave', () => {
    const legacy = {
      id: 3,
      pix_key: null,
      bank_name: 'Itaú',
      bank_agency: '0001',
      bank_account: '9-9',
    };
    expect(openDestination(legacy)).toEqual(legacy);
    setFieldKeysForTests({ current: KEY });
    expect(openDestination(legacy)).toEqual(legacy);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('o que não decifra vira "[indisponível]", com um warn por saque que não traz o valor', () => {
    setFieldKeysForTests({ current: OTHER });
    const sealedWithOther = sealField('0001');
    setFieldKeysForTests({ current: KEY });
    const row = {
      id: 77,
      pix_key: null,
      bank_name: sealField('Banco do Brasil'),
      bank_agency: sealedWithOther, // chave que não está configurada
      bank_account: 'enc:v1:quebrado', // corrompido
    };

    const out = openDestination(row);

    expect(out).toEqual({
      id: 77,
      pix_key: null,
      bank_name: 'Banco do Brasil',
      bank_agency: FIELD_UNAVAILABLE,
      bank_account: FIELD_UNAVAILABLE,
    });
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    const [context, message] = h.logger.warn.mock.calls[0]!;
    expect(context).toEqual({
      withdrawalId: 77,
      failed: [
        { column: 'bank_agency', reason: 'unknown_key' },
        { column: 'bank_account', reason: 'malformed' },
      ],
    });
    expect(message).toContain('[indisponível]');
    const logged = JSON.stringify(h.logger.warn.mock.calls);
    expect(logged).not.toContain(sealedWithOther);
    expect(logged).not.toContain('0001');
  });

  it('linha sem as colunas de destino (ou com elas indefinidas) passa sem ganhar campo', () => {
    setFieldKeysForTests({ current: KEY });
    const out = openDestination({ id: 1, amount: '10.00' });
    expect(out).toStrictEqual({ id: 1, amount: '10.00' });
  });

  it('o maior destino aceito pela API cabe cifrado nas colunas da 0039 (3 bytes por caractere)', () => {
    setFieldKeysForTests({ current: KEY });
    const migration = readFileSync(
      join(__dirname, '../../../db/migrations/0039_cifra_destino_saque.sql'),
      'utf8',
    );
    const sizes = Object.fromEntries(
      [...migration.matchAll(/MODIFY COLUMN (\w+) VARCHAR\((\d+)\) NULL/g)].map((m) => [
        m[1],
        Number(m[2]),
      ]),
    );
    expect(Object.keys(sizes).sort()).toEqual([...DESTINATION_COLUMNS].sort());

    // "€" tem 3 bytes em UTF-8 e conta 1 no limite do zod: é o pior caso que passa na validação.
    const widest = (n: number): string => '€'.repeat(n);
    const pix = createWithdrawalSchema.parse({ amount: 50, method: 'pix', pixKey: widest(255) });
    const bank = createWithdrawalSchema.parse({
      amount: 50,
      method: 'bank',
      bankName: widest(100),
      bankAgency: widest(10),
      bankAccount: widest(20),
    });
    expect(() =>
      createWithdrawalSchema.parse({ amount: 50, method: 'pix', pixKey: widest(256) }),
    ).toThrow();

    const longest = {
      pix_key: sealField(pix.pixKey!),
      bank_name: sealField(bank.bankName!),
      bank_agency: sealField(bank.bankAgency!),
      bank_account: sealField(bank.bankAccount!),
    };
    for (const column of DESTINATION_COLUMNS) {
      expect(longest[column].length, column).toBeLessThanOrEqual(sizes[column]!);
      // O cifrado é ASCII: caracteres e bytes são o mesmo número na coluna.
      expect(Buffer.byteLength(longest[column]), column).toBe(longest[column].length);
    }
  });

  it('a API recusa destino que já chega com o prefixo dos cifrados (formato reservado)', () => {
    const sealedLike = 'enc:v1:abcdef01:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA';
    for (const body of [
      { amount: 50, method: 'pix', pixKey: sealedLike },
      { amount: 50, method: 'pix', pixKey: '  enc:v1:x' }, // o trim vem antes
      { amount: 50, method: 'bank', bankName: sealedLike, bankAgency: '1', bankAccount: '2' },
      { amount: 50, method: 'bank', bankName: 'BB', bankAgency: 'enc:v1:1', bankAccount: '2' },
      { amount: 50, method: 'bank', bankName: 'BB', bankAgency: '1', bankAccount: 'enc:v1:2' },
    ]) {
      const parsed = createWithdrawalSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(body)).toBe(false);
      expect(parsed.error!.issues.map((i) => i.message)).toContain('Valor inválido');
    }
    // Parecido não é igual: só o prefixo exato é reservado.
    expect(
      createWithdrawalSchema.safeParse({ amount: 50, method: 'pix', pixKey: 'enc@escambo.test' })
        .success,
    ).toBe(true);
  });
});
