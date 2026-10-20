import { logger } from '../../config/logger';
import { clock } from '../../utils/clock';
import { isSealedField, openField } from '../../utils/field-crypto';
import { HttpError } from '../../utils/http-error';
import { userAgentOf } from '../../utils/user-agent';
import { auditService } from '../audit/audit.service';
import { mfaRepository, type MfaRow } from './mfa.repository';
import {
  findUnusedRecoveryCode,
  isRecoveryCodeShape,
  normalizeRecoveryCode,
  parseStoredRecoveryCodes,
  recoveryCodesLeft,
} from './recovery-codes';
import { base32Decode, TOTP_DIGITS, verifyTotp } from './totp';

/**
 * A conferência do segundo fator (ADR 66), a mesma no login, na ativação, na desativação e na
 * troca dos códigos de recuperação: trava depois de 5 erros seguidos, TOTP com anti-reuso e código
 * de recuperação de uso único. Fica fora do mfa.service porque o login (authService) também usa, e
 * o mfa.service usa o authService para abrir a sessão nova: assim o grafo não fecha ciclo.
 */

/** Onde o código foi digitado: vai para a auditoria, nunca o código. */
export type MfaContext = 'login' | 'enable' | 'disable' | 'recovery_codes';

export interface MfaRequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

/** Como o código conferiu: o passo do TOTP aceito, ou quantos códigos de recuperação sobraram. */
export interface VerifiedFactor {
  method: 'totp' | 'recovery';
  step: number | null;
  recoveryCodesLeft: number | null;
}

export const mfaLockedError = (): HttpError =>
  new HttpError(429, 'Muitas tentativas. Tente de novo em 15 minutos.', 'mfa_locked');

export const invalidMfaCodeError = (): HttpError =>
  new HttpError(
    400,
    'Código inválido. Confira o app autenticador (ou o código de recuperação) e tente de novo.',
    'invalid_mfa_code',
  );

/** A linha com a 2FA ligada (is_enabled = 1), ou null: a pendente da ativação não conta. */
export function enabledMfa(row: MfaRow | undefined): MfaRow | null {
  return row && Number(row.is_enabled) === 1 ? row : null;
}

/** O que a pessoa digitou: 6 dígitos (espaços no meio valem) ou um código de recuperação. */
export function parseMfaCode(input: string): { kind: 'totp' | 'recovery'; code: string } | null {
  const compact = input.replace(/\s/g, '');
  if (new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(compact)) return { kind: 'totp', code: compact };
  const normalized = normalizeRecoveryCode(input);
  return isRecoveryCodeShape(normalized) ? { kind: 'recovery', code: normalized } : null;
}

/**
 * Abre o segredo gravado (sempre cifrado, RNF-042). Valor em texto puro, chave errada ou dado
 * estragado: 500 mfa_unreadable, com o motivo no log e nunca o valor. Falha fechado: sem o
 * segredo, o código do app não confere e ninguém passa por ele (o de recuperação ainda vale).
 */
export function openMfaSecret(row: MfaRow): Buffer {
  const fail = (reason: string): never => {
    logger.error({ userId: row.user_id, reason }, 'segredo da verificação em duas etapas ilegível');
    throw new HttpError(
      500,
      'Não foi possível conferir o código do app nesta conta. Use um código de recuperação ou fale com o suporte.',
      'mfa_unreadable',
    );
  };
  const stored = Buffer.isBuffer(row.secret) ? row.secret.toString('utf8') : row.secret;
  if (!stored || !isSealedField(stored)) return fail('not_sealed');
  const opened = openField(stored);
  if (!opened.ok) return fail(opened.reason);
  const key = base32Decode(opened.value);
  if (!key || key.length === 0) return fail('malformed');
  return key;
}

/**
 * Confere o código contra a linha da conta. Acerto zera os erros; erro soma um e, no quinto,
 * trava por 15 minutos (429 já neste). Na linha ainda pendente (ativação) só vale o TOTP, e quem
 * grava o passo aceito é a própria ativação, na mesma instrução que liga a 2FA.
 */
export async function verifySecondFactor(
  row: MfaRow,
  input: string,
  opts: { context: MfaContext; ctx: MfaRequestContext },
): Promise<VerifiedFactor> {
  if (Number(row.locked) === 1) throw mfaLockedError();
  const now = clock.now();
  const enabled = enabledMfa(row) !== null;
  const audit = (action: string, newValue: Record<string, unknown>): void => {
    void auditService.log({
      userId: row.user_id,
      action,
      entityType: 'user',
      entityId: row.user_id,
      newValue: { context: opts.context, ...newValue },
      ip: opts.ctx.ip ?? null,
      userAgent: userAgentOf(opts.ctx.userAgent),
    });
  };

  const parsed = parseMfaCode(input);
  if (parsed?.kind === 'totp') {
    const lastUsed = row.last_used_step === null ? null : Number(row.last_used_step);
    const step = verifyTotp(openMfaSecret(row), parsed.code, now, lastUsed);
    if (step !== null && (!enabled || (await mfaRepository.acceptStep(row.id, step)))) {
      return { method: 'totp', step, recoveryCodesLeft: null };
    }
  } else if (parsed?.kind === 'recovery' && enabled) {
    const codes = parseStoredRecoveryCodes(row.recovery_codes);
    const index = findUnusedRecoveryCode(codes, row.user_id, parsed.code);
    if (index >= 0 && (await mfaRepository.useRecoveryCode(row.id, index, codes[index]!.h, now))) {
      const left = recoveryCodesLeft(codes) - 1;
      audit('auth.mfa_recovery_used', { recoveryCodesLeft: left });
      return { method: 'recovery', step: null, recoveryCodesLeft: left };
    }
  }

  const locked = await mfaRepository.registerFailure(row.id, now);
  audit('auth.mfa_failed', { locked });
  throw locked ? mfaLockedError() : invalidMfaCodeError();
}
