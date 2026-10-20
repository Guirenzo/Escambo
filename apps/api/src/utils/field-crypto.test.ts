import { createCipheriv } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../config/logger', () => ({ logger: h.logger }));

import {
  currentSealPrefix,
  FIELD_UNAVAILABLE,
  fieldEncryptionEnabled,
  fieldKeyId,
  isSealedField,
  logFieldEncryptionStatus,
  openField,
  resealField,
  sealField,
  sealNullableField,
  setFieldKeysForTests,
} from './field-crypto';

const KEY_A = Buffer.alloc(32, 0xa1).toString('base64');
const KEY_B = Buffer.alloc(32, 0xb2).toString('base64');
const ID_A = fieldKeyId(Buffer.from(KEY_A, 'base64'));
const ID_B = fieldKeyId(Buffer.from(KEY_B, 'base64'));

const FORMAT = /^enc:v1:([0-9a-f]{8}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]*)$/;
const PIX = 'chave-secreta@escambo.test';

/** As partes do texto cifrado: [impressão, iv, tag, cifra]. */
const parts = (sealed: string): string[] => FORMAT.exec(sealed)!.slice(1);
const join = ([id, iv, tag, data]: string[]): string => `enc:v1:${id}:${iv}:${tag}:${data}`;

/** Troca um caractere base64url por outro (muda bits que contam, não só o preenchimento). */
const flip = (s: string, at = 0): string =>
  s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1);

afterEach(() => setFieldKeysForTests(null));
beforeEach(() => vi.clearAllMocks());

/**
 * Cifragem de campo (RNF-017): AES-256-GCM com IV aleatório e tag, no formato versionado
 * enc:v1:<chave>:<iv>:<tag>:<cifra>. Convive com o texto puro das linhas antigas e nunca derruba
 * a leitura: o que não decifra volta com o motivo, para quem lê mostrar "[indisponível]".
 */
describe('field-crypto (RNF-017)', () => {
  describe('com a chave configurada', () => {
    beforeEach(() => setFieldKeysForTests({ current: KEY_A }));

    it('ida e volta: o gravado tem o formato versionado, não contém o valor, e decifra no valor', () => {
      const sealed = sealField(PIX);

      expect(sealed).toMatch(FORMAT);
      expect(parts(sealed)[0]).toBe(ID_A);
      expect(sealed).not.toContain(PIX);
      expect(sealed).not.toContain('chave-secreta');
      expect(isSealedField(sealed)).toBe(true);
      expect(openField(sealed)).toEqual({ ok: true, value: PIX });
    });

    it('acentos, emoji e texto vazio voltam iguais (UTF-8)', () => {
      for (const value of ['Itaú Unibanco — agência São José', '🔑 chave', '']) {
        expect(openField(sealField(value))).toEqual({ ok: true, value });
      }
    });

    it('o mesmo valor cifra diferente a cada vez: IV aleatório de 12 bytes por valor', () => {
      const seals = Array.from({ length: 20 }, () => sealField(PIX));

      expect(new Set(seals).size).toBe(20);
      expect(new Set(seals.map((s) => parts(s)[1])).size).toBe(20);
      for (const s of seals) {
        expect(Buffer.from(parts(s)[1]!, 'base64url')).toHaveLength(12);
        expect(Buffer.from(parts(s)[2]!, 'base64url')).toHaveLength(16);
        expect(openField(s)).toEqual({ ok: true, value: PIX });
      }
    });

    it('adulteração é detectada pela tag: cifra, tag ou IV alterados não decifram', () => {
      const [id, iv, tag, data] = parts(sealField(PIX));

      expect(openField(join([id!, iv!, tag!, flip(data!)]))).toEqual({
        ok: false,
        reason: 'tampered',
      });
      expect(openField(join([id!, iv!, flip(tag!), data!]))).toEqual({
        ok: false,
        reason: 'tampered',
      });
      expect(openField(join([id!, flip(iv!), tag!, data!]))).toEqual({
        ok: false,
        reason: 'tampered',
      });
      // Cifra encurtada (um bloco a menos) também.
      expect(openField(join([id!, iv!, tag!, data!.slice(0, -4)]))).toMatchObject({ ok: false });
    });

    it('o cabeçalho é autenticado: trocar a impressão pela de outra chave configurada não decifra', () => {
      setFieldKeysForTests({ current: KEY_A, old: [KEY_B] });
      const [, iv, tag, data] = parts(sealField(PIX));

      expect(openField(join([ID_B, iv!, tag!, data!]))).toEqual({ ok: false, reason: 'tampered' });
    });

    it('com a impressão certa e a chave errada, a tag recusa (não devolve lixo)', () => {
      // Cifra com KEY_B mas grava a impressão de KEY_A: só a tag pode dizer que não é dela.
      const header = `enc:v1:${ID_A}:`;
      const iv = Buffer.alloc(12, 7);
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY_B, 'base64'), iv);
      cipher.setAAD(Buffer.from(header));
      const data = Buffer.concat([cipher.update(PIX, 'utf8'), cipher.final()]);
      const forged = `${header}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;

      expect(openField(forged)).toEqual({ ok: false, reason: 'tampered' });
    });

    it('chave errada: cifrado com outra chave, fora da atual e das antigas, não é lido', () => {
      const sealed = sealField(PIX);
      setFieldKeysForTests({ current: KEY_B });

      expect(openField(sealed)).toEqual({ ok: false, reason: 'unknown_key' });
    });

    it('texto com o prefixo mas fora do formato é recusado como malformado, sem tentar decifrar', () => {
      const [id, iv, tag, data] = parts(sealField(PIX));
      const malformed = [
        'enc:v1:',
        'enc:v1:abc',
        `enc:v1:${id}:${iv}:${tag}`, // falta a cifra
        `enc:v1:${id}:${iv}:${tag}:${data}:extra`,
        `enc:v1:${id!.toUpperCase()}x:${iv}:${tag}:${data}`, // impressão fora do formato
        `enc:v1:${id}:${iv!.slice(1)}:${tag}:${data}`, // IV curto
        `enc:v1:${id}:${iv}:${tag}A:${data}`, // tag longa
        `enc:v1:${id}:${iv}:${tag}:${data}=`, // preenchimento: não é base64url canônico
        `enc:v1:${id}:${iv}:${tag}:da+ta`, // alfabeto do base64 comum
        `enc:v1:${id}:${iv}:${tag}:AB`, // bits de sobra ligados: o Buffer leria "AA"
      ];
      for (const value of malformed) {
        expect(openField(value), value).toEqual({ ok: false, reason: 'malformed' });
      }
    });

    it('linha antiga em texto puro continua legível, como está', () => {
      for (const value of [PIX, 'Banco do Brasil', '0001', '12345-6', '', 'ENC:V1:maiúsculo']) {
        expect(isSealedField(value)).toBe(false);
        expect(openField(value)).toEqual({ ok: true, value });
      }
    });

    it('null continua null; o que tem valor é cifrado', () => {
      expect(sealNullableField(null)).toBeNull();
      expect(openField(sealNullableField('0001')!)).toEqual({ ok: true, value: '0001' });
      expect(fieldEncryptionEnabled()).toBe(true);
      expect(currentSealPrefix()).toBe(`enc:v1:${ID_A}:`);
    });
  });

  describe('sem chave configurada', () => {
    it('grava como antes, em texto puro, e lê o texto puro', () => {
      setFieldKeysForTests({});

      expect(fieldEncryptionEnabled()).toBe(false);
      expect(currentSealPrefix()).toBeNull();
      expect(sealField(PIX)).toBe(PIX);
      expect(sealNullableField('0001')).toBe('0001');
      expect(openField(PIX)).toEqual({ ok: true, value: PIX });
    });

    it('valor que já estava cifrado não decifra e diz por quê (no_key), sem lançar', () => {
      setFieldKeysForTests({ current: KEY_A });
      const sealed = sealField(PIX);
      setFieldKeysForTests({});

      expect(openField(sealed)).toEqual({ ok: false, reason: 'no_key' });
    });

    it('é o padrão do ambiente dos testes de unidade (FIELD_ENCRYPTION_KEY vazia)', () => {
      setFieldKeysForTests({ current: KEY_A });
      setFieldKeysForTests(null);
      expect(fieldEncryptionEnabled()).toBe(false);
    });
  });

  describe('rotação de chave', () => {
    it('a chave antiga só decifra; a atual cifra e decifra', () => {
      setFieldKeysForTests({ current: KEY_A });
      const old = sealField(PIX);
      setFieldKeysForTests({ current: KEY_B, old: [KEY_A] });

      expect(openField(old)).toEqual({ ok: true, value: PIX });
      const fresh = sealField(PIX);
      expect(parts(fresh)[0]).toBe(ID_B);
      expect(openField(fresh)).toEqual({ ok: true, value: PIX });
    });

    it('resealField: texto puro e chave antiga são cifrados com a atual; o da atual fica; o ilegível também', () => {
      setFieldKeysForTests({ current: KEY_A });
      const withA = sealField(PIX);
      setFieldKeysForTests({ current: KEY_B });
      const withB = sealField(PIX);
      const unknown = `enc:v1:00000000:${parts(withB).slice(1).join(':')}`;
      setFieldKeysForTests({ current: KEY_B, old: [KEY_A] });

      const fromPlain = resealField(PIX);
      expect(fromPlain).toMatchObject({ status: 'sealed' });
      const plainSealed = (fromPlain as { value: string }).value;
      expect(plainSealed.startsWith(`enc:v1:${ID_B}:`)).toBe(true);
      expect(openField(plainSealed)).toEqual({ ok: true, value: PIX });

      const fromOld = resealField(withA);
      expect(fromOld).toMatchObject({ status: 'sealed' });
      expect(parts((fromOld as { value: string }).value)[0]).toBe(ID_B);
      expect(openField((fromOld as { value: string }).value)).toEqual({ ok: true, value: PIX });

      expect(resealField(withB)).toEqual({ status: 'current' });
      expect(resealField(unknown)).toEqual({ status: 'unreadable', reason: 'unknown_key' });
      expect(resealField('enc:v1:quebrado')).toEqual({ status: 'unreadable', reason: 'malformed' });
    });

    it('resealField sem chave atual recusa: não há com o que cifrar', () => {
      setFieldKeysForTests({ old: [KEY_A] });
      expect(() => resealField(PIX)).toThrow('FIELD_ENCRYPTION_KEY não configurada');
    });

    it('a impressão identifica a chave sem revelá-la: 8 hex, estável, diferente por chave', () => {
      expect(ID_A).toMatch(/^[0-9a-f]{8}$/);
      expect(fieldKeyId(Buffer.from(KEY_A, 'base64'))).toBe(ID_A);
      expect(ID_B).not.toBe(ID_A);
      expect(KEY_A).not.toContain(ID_A);
    });

    it('chave que não tem 32 bytes não é aceita', () => {
      expect(() => setFieldKeysForTests({ current: Buffer.alloc(16).toString('base64') })).toThrow(
        '32 bytes',
      );
      expect(() => setFieldKeysForTests({ current: KEY_A, old: ['curta'] })).toThrow('32 bytes');
    });
  });

  describe('aviso na subida', () => {
    it('com a chave: info com a impressão e quantas antigas, nunca a chave', () => {
      setFieldKeysForTests({ current: KEY_B, old: [KEY_A] });

      logFieldEncryptionStatus(true);

      expect(h.logger.warn).not.toHaveBeenCalled();
      expect(h.logger.info.mock.calls).toEqual([
        [
          { keyId: ID_B, oldKeys: 1 },
          'Cifragem de campo ligada (RNF-017): chave PIX e dados bancários dos saques, e o segredo da verificação em duas etapas',
        ],
      ]);
      expect(JSON.stringify(h.logger.info.mock.calls)).not.toContain(KEY_B);
    });

    it('sem a chave em produção: warn claro, uma linha', () => {
      setFieldKeysForTests({});

      logFieldEncryptionStatus(true);

      expect(h.logger.info).not.toHaveBeenCalled();
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      const [message] = h.logger.warn.mock.calls[0]!;
      expect(message).toContain('FIELD_ENCRYPTION_KEY não configurada');
      expect(message).toContain('TEXTO PURO');
      expect(message).toContain('fields:encrypt');
      expect(message).toContain('verificação em duas etapas fica indisponível');
    });

    it('sem a chave fora de produção (o padrão daqui): só info', () => {
      setFieldKeysForTests({});

      logFieldEncryptionStatus();

      expect(h.logger.warn).not.toHaveBeenCalled();
      expect(h.logger.info).toHaveBeenCalledTimes(1);
      expect(h.logger.info.mock.calls[0]![0]).toContain('TEXTO PURO');
    });
  });

  it('o marcador do ilegível é claro e não se confunde com valor cifrado', () => {
    expect(FIELD_UNAVAILABLE).toBe('[indisponível]');
    expect(isSealedField(FIELD_UNAVAILABLE)).toBe(false);
  });
});
