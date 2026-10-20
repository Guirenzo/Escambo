import { createHash, randomInt } from 'node:crypto';

/**
 * Códigos de recuperação da verificação em duas etapas (ADR 66): para quem perdeu o celular. Dez
 * códigos de uso único, XXXX-XXXX no alfabeto de Crockford (sem I, L, O e U, que se confundem com
 * 1, 0 e V), 40 bits cada. O banco guarda só o hash, com o id da conta no texto: o mesmo código em
 * duas contas não dá o mesmo hash, e um vazamento da tabela não entrega código que funcione.
 */

export const RECOVERY_CODE_COUNT = 10;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SHAPE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Como fica gravado em user_mfa.recovery_codes: o hash e quando foi usado (ISO), ou null. */
export interface StoredRecoveryCode {
  h: string;
  usedAt: string | null;
}

/** Códigos novos, distintos, no formato que a pessoa vê (XXXX-XXXX). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += CROCKFORD[randomInt(CROCKFORD.length)];
    codes.add(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return [...codes];
}

/**
 * O código como foi digitado vira a forma canônica: maiúsculas, sem espaço nem hífen, e as letras
 * que o Crockford não usa voltam ao dígito que parecem (O vira 0; I e L viram 1).
 */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Tem a forma de um código de recuperação (já normalizado)? */
export function isRecoveryCodeShape(normalized: string): boolean {
  return SHAPE.test(normalized);
}

export function hashRecoveryCode(userId: number, normalized: string): string {
  return createHash('sha256').update(`escambo:mfa-recovery:${userId}:${normalized}`).digest('hex');
}

/** O que vai para o banco: só os hashes, todos ainda sem uso. */
export function storeRecoveryCodes(userId: number, codes: string[]): StoredRecoveryCode[] {
  return codes.map((code) => ({
    h: hashRecoveryCode(userId, normalizeRecoveryCode(code)),
    usedAt: null,
  }));
}

/** Lê a coluna JSON (o mysql2 já devolve o objeto; texto também serve). Formato estranho: vazio. */
export function parseStoredRecoveryCodes(raw: unknown): StoredRecoveryCode[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (c): c is StoredRecoveryCode =>
      !!c &&
      typeof (c as StoredRecoveryCode).h === 'string' &&
      ((c as StoredRecoveryCode).usedAt === null ||
        typeof (c as StoredRecoveryCode).usedAt === 'string'),
  );
}

export function recoveryCodesLeft(codes: StoredRecoveryCode[]): number {
  return codes.filter((c) => c.usedAt === null).length;
}

/** A posição do código ainda não usado com esse hash na lista gravada, ou -1. */
export function findUnusedRecoveryCode(
  codes: StoredRecoveryCode[],
  userId: number,
  normalized: string,
): number {
  const hash = hashRecoveryCode(userId, normalized);
  return codes.findIndex((c) => c.usedAt === null && c.h === hash);
}
