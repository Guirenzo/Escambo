import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  findUnusedRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  isRecoveryCodeShape,
  normalizeRecoveryCode,
  parseStoredRecoveryCodes,
  RECOVERY_CODE_COUNT,
  recoveryCodesLeft,
  storeRecoveryCodes,
} from './recovery-codes';

/** Códigos de recuperação (ADR 66): formato, normalização do que se digita e uso único. */
describe('códigos de recuperação', () => {
  it('são 10, distintos, no formato XXXX-XXXX do alfabeto de Crockford', () => {
    const codes = generateRecoveryCodes();
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(isRecoveryCodeShape(normalizeRecoveryCode(code))).toBe(true);
    }
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });

  it('o que se digita vira a forma canônica: maiúsculas, sem espaço nem hífen, O→0, I e L→1', () => {
    expect(normalizeRecoveryCode('ab12-cd34')).toBe('AB12CD34');
    expect(normalizeRecoveryCode(' ab12 cd34 ')).toBe('AB12CD34');
    expect(normalizeRecoveryCode('oOiI-lL00')).toBe('00111100');
  });

  it('a forma: 8 caracteres do alfabeto (sem I, L, O e U)', () => {
    expect(isRecoveryCodeShape('AB12CD34')).toBe(true);
    for (const text of ['AB12CD3', 'AB12CD345', 'AB12CDU4', 'ab12cd34', 'AB12-CD3']) {
      expect(isRecoveryCodeShape(text), text).toBe(false);
    }
  });

  it('o hash leva o id da conta: o mesmo código em duas contas não dá o mesmo hash', () => {
    const expected = createHash('sha256').update('escambo:mfa-recovery:7:AB12CD34').digest('hex');
    expect(hashRecoveryCode(7, 'AB12CD34')).toBe(expected);
    expect(hashRecoveryCode(8, 'AB12CD34')).not.toBe(expected);
  });

  it('gravados só como hash, todos livres; achar o código digitado de qualquer jeito', () => {
    const stored = storeRecoveryCodes(7, ['AB12-CD34', 'EF56-GH78']);
    expect(stored).toEqual([
      { h: hashRecoveryCode(7, 'AB12CD34'), usedAt: null },
      { h: hashRecoveryCode(7, 'EF56GH78'), usedAt: null },
    ]);
    expect(JSON.stringify(stored)).not.toContain('AB12');
    expect(recoveryCodesLeft(stored)).toBe(2);
    expect(findUnusedRecoveryCode(stored, 7, normalizeRecoveryCode('ef56 gh78'))).toBe(1);
    // De outra conta, não acha.
    expect(findUnusedRecoveryCode(stored, 8, 'EF56GH78')).toBe(-1);
  });

  it('código já usado não é achado de novo e não conta como restante', () => {
    const stored = storeRecoveryCodes(7, ['AB12-CD34', 'EF56-GH78']);
    stored[0]!.usedAt = '2026-10-20T12:00:00.000Z';
    expect(findUnusedRecoveryCode(stored, 7, 'AB12CD34')).toBe(-1);
    expect(recoveryCodesLeft(stored)).toBe(1);
  });

  it('a coluna JSON é lida como vem do mysql2 (array) ou como texto; o resto vira lista vazia', () => {
    const list = [{ h: 'a', usedAt: null }];
    expect(parseStoredRecoveryCodes(list)).toEqual(list);
    expect(parseStoredRecoveryCodes(JSON.stringify(list))).toEqual(list);
    expect(parseStoredRecoveryCodes(null)).toEqual([]);
    expect(parseStoredRecoveryCodes('{quebrado')).toEqual([]);
    expect(parseStoredRecoveryCodes({ h: 'a' })).toEqual([]);
    // Entradas fora do formato são descartadas, as boas ficam.
    expect(
      parseStoredRecoveryCodes([
        null,
        { h: 1, usedAt: null },
        { h: 'b', usedAt: 3 },
        { h: 'c', usedAt: '2026-10-20T12:00:00.000Z' },
      ]),
    ).toEqual([{ h: 'c', usedAt: '2026-10-20T12:00:00.000Z' }]);
  });
});
