import bcrypt from 'bcryptjs';
import type {
  MfaEnabledResponse,
  MfaRecoveryCodesResponse,
  MfaSetup,
  MfaStatus,
} from '@escambo/types';
import { env } from '../../config/env';
import { clock } from '../../utils/clock';
import { fieldEncryptionEnabled, isSealedField, sealField } from '../../utils/field-crypto';
import { HttpError } from '../../utils/http-error';
import { userAgentOf } from '../../utils/user-agent';
import { auditService } from '../audit/audit.service';
import { mailService } from '../mail/mail.service';
import { authRepository, type UserRow } from './auth.repository';
import { appLink, issueSession, type RequestContext } from './auth.service';
import type { MfaConfirmInput } from './auth.schema';
import { mfaRepository, type MfaRow } from './mfa.repository';
import { sessionRepository } from './session.repository';
import { enabledMfa, mfaLockedError, verifySecondFactor } from './mfa.verify';
import {
  generateRecoveryCodes,
  parseStoredRecoveryCodes,
  recoveryCodesLeft,
  storeRecoveryCodes,
} from './recovery-codes';
import { generateTotpSecret, otpauthUrl } from './totp';

/**
 * Verificação em duas etapas da própria conta (RF-090, RNF-042, ADR 66): ver a situação, começar
 * (o segredo novo, cifrado), ativar com o primeiro código, desativar e trocar os códigos de
 * recuperação. Tudo pede a senha atual, menos ver e ativar (que vem logo depois do começo, e o
 * código do app já prova que é o titular com o celular na mão). O login com o segundo fator mora
 * no authService.
 */

async function accountOf(userId: number): Promise<UserRow> {
  const user = await authRepository.findById(userId);
  if (!user) throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
  return user;
}

/** A mesma conferência da troca de senha (RF-017): conta sem senha gravada também não passa. */
async function assertPassword(user: UserRow, password: string): Promise<void> {
  const ok = user.password_hash != null && (await bcrypt.compare(password, user.password_hash));
  if (!ok) throw new HttpError(400, 'Senha atual incorreta', 'wrong_password');
}

async function enabledRow(userId: number): Promise<MfaRow> {
  const row = enabledMfa(await mfaRepository.findByUser(userId, clock.now()));
  if (!row) {
    throw new HttpError(
      409,
      'A verificação em duas etapas não está ativa nesta conta.',
      'mfa_not_enabled',
    );
  }
  return row;
}

const unavailable = (): HttpError =>
  new HttpError(
    503,
    'A verificação em duas etapas ainda não está disponível neste servidor.',
    'mfa_unavailable',
  );

const alreadyEnabled = (): HttpError =>
  new HttpError(
    409,
    'A verificação em duas etapas já está ativa nesta conta.',
    'mfa_already_enabled',
  );

function audit(userId: number, action: string, newValue: unknown, ctx: RequestContext): void {
  void auditService.log({
    userId,
    action,
    entityType: 'user',
    entityId: userId,
    newValue,
    ip: ctx.ip,
    userAgent: userAgentOf(ctx.userAgent),
  });
}

export const mfaService = {
  /** `available`: o servidor consegue guardar o segredo cifrado (sem FIELD_ENCRYPTION_KEY, não). */
  async status(userId: number, role: string): Promise<MfaStatus> {
    const row = enabledMfa(await mfaRepository.findByUser(userId, clock.now()));
    return {
      enabled: row !== null,
      confirmedAt: row?.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
      recoveryCodesLeft: row ? recoveryCodesLeft(parseStoredRecoveryCodes(row.recovery_codes)) : 0,
      available: fieldEncryptionEnabled(),
      required: env.ADMIN_MFA_REQUIRED && role === 'admin',
    };
  },

  /**
   * Começa a ativação: um segredo novo, gravado cifrado e ainda inativo (troca o pendente de antes,
   * se havia). O segredo vai na resposta para o app; no banco, só cifrado — sem a chave de
   * cifragem a 2FA fica indisponível (503), nunca em texto puro.
   */
  async setup(userId: number, password: string): Promise<MfaSetup> {
    if (!fieldEncryptionEnabled()) throw unavailable();
    const user = await accountOf(userId);
    await assertPassword(user, password);
    const row = await mfaRepository.findByUser(userId, clock.now());
    if (enabledMfa(row)) throw alreadyEnabled();
    // Recomeçar não zera a trava: quem errou 5 vezes espera os 15 minutos como no login.
    if (row && Number(row.locked) === 1) throw mfaLockedError();

    const secret = generateTotpSecret();
    const sealed = sealField(secret);
    // A chave foi conferida acima; isto segura uma regressão no field-crypto: texto puro não grava.
    if (!isSealedField(sealed)) throw unavailable();
    await mfaRepository.savePending(userId, sealed);
    return { secret, otpauthUrl: otpauthUrl(user.email, secret) };
  },

  /**
   * Ativa com o primeiro código do app: gera os 10 códigos de recuperação (mostrados só agora),
   * encerra TODAS as sessões e abre uma nova para quem ativou, como a troca de senha (RF-017) —
   * quem estava com a conta aberta em outro lugar precisa entrar de novo, já com o segundo fator.
   */
  async enable(userId: number, code: string, ctx: RequestContext): Promise<MfaEnabledResponse> {
    const user = await accountOf(userId);
    const row = await mfaRepository.findByUser(userId, clock.now());
    if (!row) {
      throw new HttpError(
        400,
        'Comece a ativação pelo QR code antes de confirmar o código.',
        'mfa_not_started',
      );
    }
    if (enabledMfa(row)) throw alreadyEnabled();
    // Na linha pendente só o TOTP confere (ainda não há código de recuperação): sempre há passo.
    const factor = await verifySecondFactor(row, code, { context: 'enable', ctx });

    const recoveryCodes = generateRecoveryCodes();
    const activated = await mfaRepository.enable(row.id, {
      sealedSecret: row.secret!,
      step: factor.step!,
      recoveryCodes: storeRecoveryCodes(userId, recoveryCodes),
      now: clock.now(),
    });
    // Outra requisição ativou (ou recomeçou) no meio: esta não vale.
    if (!activated) throw alreadyEnabled();

    const revoked = await sessionRepository.revokeAllForUser(userId);
    const tokens = await issueSession(user, ctx);
    audit(userId, 'mfa_enabled', { sessionsRevoked: revoked }, ctx);
    // Aviso de segurança: vai mesmo com os e-mails de novidades desligados. Melhor esforço.
    await mailService.send({
      userId,
      to: user.email,
      template: 'notification',
      vars: {
        title: 'Verificação em duas etapas ativada',
        body: 'A verificação em duas etapas foi ativada na sua conta do Escambo, e as outras sessões abertas foram encerradas. Daqui para a frente, a entrada pede também o código do app autenticador. Se não foi você, redefina a senha agora e fale com o suporte.',
        link: appLink('/perfil'),
        cta: 'Abrir o perfil',
      },
    });
    return { ...tokens, recoveryCodes };
  },

  /** Desativa com a senha e um código (do app ou de recuperação). O titular é avisado por e-mail. */
  async disable(userId: number, input: MfaConfirmInput, ctx: RequestContext): Promise<void> {
    const user = await accountOf(userId);
    await assertPassword(user, input.password);
    const row = await enabledRow(userId);
    const factor = await verifySecondFactor(row, input.code, { context: 'disable', ctx });
    await mfaRepository.deleteForUser(userId);
    audit(userId, 'mfa_disabled', { method: factor.method }, ctx);
    await mailService.send({
      userId,
      to: user.email,
      template: 'notification',
      vars: {
        title: 'Verificação em duas etapas desativada',
        body: 'A verificação em duas etapas da sua conta do Escambo foi desativada: a entrada volta a pedir só a senha. Se não foi você, troque a senha e fale com o suporte.',
        link: appLink('/perfil'),
        cta: 'Abrir o perfil',
      },
    });
  },

  /** Troca os códigos de recuperação (senha + código); os anteriores deixam de valer na hora. */
  async regenerateRecoveryCodes(
    userId: number,
    input: MfaConfirmInput,
    ctx: RequestContext,
  ): Promise<MfaRecoveryCodesResponse> {
    const user = await accountOf(userId);
    await assertPassword(user, input.password);
    const row = await enabledRow(userId);
    const factor = await verifySecondFactor(row, input.code, { context: 'recovery_codes', ctx });
    const recoveryCodes = generateRecoveryCodes();
    const replaced = await mfaRepository.replaceRecoveryCodes(
      row.id,
      storeRecoveryCodes(userId, recoveryCodes),
    );
    // Desativada no meio (outra aba, ou o atendimento): os códigos novos não valeriam.
    if (!replaced) {
      throw new HttpError(
        409,
        'A verificação em duas etapas não está ativa nesta conta.',
        'mfa_not_enabled',
      );
    }
    audit(userId, 'mfa_recovery_codes_regenerated', { method: factor.method }, ctx);
    return { recoveryCodes };
  },
};
