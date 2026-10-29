import bcrypt from 'bcryptjs';
import type {
  AccountContact,
  ConfirmEmailChangeResponse,
  PendingEmailChange,
} from '@escambo/types';
import { env } from '../../config/env';
import { HttpError } from '../../utils/http-error';
import { generateRefreshToken, hashToken } from '../../utils/tokens';
import { userAgentOf } from '../../utils/user-agent';
import { auditService } from '../audit/audit.service';
import { mailService } from '../mail/mail.service';
import { authRepository } from './auth.repository';
import {
  appLink,
  cancelEmailChanges,
  isAdminEmail,
  issueSession,
  type RequestContext,
} from './auth.service';
import type { ChangeEmailInput } from './auth.schema';
import { emailChangeRepository, type EmailChangeAccount } from './email-change.repository';

/**
 * Contato da conta (RF-017): troca de e-mail confirmada no endereço novo e telefone. O contato só
 * aparece para o próprio titular (GET /auth/contact); o perfil público não o recebe.
 */

/** Pedidos de troca de e-mail por conta em 24 horas (o IP tem ainda o limite do login). */
export const EMAIL_CHANGE_MAX_PER_DAY = 5;

const UNAVAILABLE_MESSAGE = 'Este e-mail não está disponível para a troca. Nada mudou na conta.';

/** "ana.souza@x.com" → "an***@x.com": o aviso e a auditoria não repetem o endereço inteiro. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, local.length <= 2 ? 1 : 2)}***${email.slice(at)}`;
}

/** Conta de administração não troca o e-mail sozinha: o acesso dela é configuração da operação. */
function adminLocked(): HttpError {
  return new HttpError(
    403,
    'Contas de administração não trocam o e-mail pelo perfil: a troca é feita pela operação da plataforma.',
    'admin_email_locked',
  );
}

/** A conta ainda pode receber a troca na hora de confirmar (o estado pode ter mudado desde o pedido). */
function assertCanConfirm(account: EmailChangeAccount, newEmail: string): void {
  if (account.deleted_at) {
    throw new HttpError(403, 'Esta conta foi excluída a pedido do titular.', 'account_deleted');
  }
  if (account.status === 'banned') {
    throw new HttpError(403, 'Conta banida. Fale com o suporte.', 'account_banned');
  }
  if (account.status === 'suspended') {
    throw new HttpError(
      403,
      'Conta suspensa: acesso somente para consulta. Esta ação está bloqueada.',
      'account_suspended',
    );
  }
  if (account.role === 'admin') throw adminLocked();
  // ADMIN_EMAILS pode ter mudado depois do pedido: a troca nunca promove uma conta comum.
  if (isAdminEmail(newEmail)) throw new HttpError(409, UNAVAILABLE_MESSAGE, 'email_unavailable');
}

/** Hora do vencimento sem os milissegundos, que a coluna DATETIME não guarda (o GET devolve igual). */
const expiryFromNow = (): Date =>
  new Date(Math.floor((Date.now() + env.EMAIL_VERIFY_TTL_HOURS * 3_600_000) / 1000) * 1000);

export const contactService = {
  async get(userId: number): Promise<AccountContact> {
    const [contact, pending] = await Promise.all([
      authRepository.findContact(userId),
      emailChangeRepository.findPending(userId),
    ]);
    if (!contact) throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    return {
      email: contact.email,
      emailVerified: contact.email_verified_at != null,
      phone: contact.phone ?? null,
      pendingEmail: pending
        ? { email: pending.new_email, expiresAt: new Date(pending.expires_at).toISOString() }
        : null,
      hasPassword: Number(contact.has_password) === 1,
      googleLinked: Number(contact.google_linked) === 1,
    };
  },

  /**
   * Pede a troca de e-mail. A senha atual confirma o titular; o endereço novo só passa a valer
   * quando o link enviado a ele é aberto. A resposta é a mesma se o endereço já for de outra conta
   * ou estiver reservado à administração: o pedido fica registrado, mas o link não sai (ninguém o
   * confirma), e quem pede não descobre por aqui quem tem conta. O endereço atual sempre recebe o
   * aviso, com o que fazer se não foi o titular.
   */
  async requestEmailChange(
    userId: number,
    input: ChangeEmailInput,
    ctx: RequestContext,
  ): Promise<PendingEmailChange> {
    const user = await authRepository.findById(userId);
    if (!user) throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    const ok =
      user.password_hash != null &&
      (await bcrypt.compare(input.currentPassword, user.password_hash));
    if (!ok) throw new HttpError(400, 'Senha atual incorreta', 'wrong_password');
    if (user.role === 'admin') throw adminLocked();
    const newEmail = input.newEmail;
    if (newEmail === user.email.trim().toLowerCase()) {
      throw new HttpError(400, 'Este já é o e-mail da sua conta', 'same_email');
    }

    const owner = await authRepository.findByEmail(newEmail);
    const blocked =
      owner && owner.id !== userId
        ? 'email_taken'
        : isAdminEmail(newEmail)
          ? 'admin_reserved'
          : null;
    const token = generateRefreshToken();
    const expiresAt = expiryFromNow();
    const requestId = await emailChangeRepository.create({
      userId,
      newEmail,
      tokenHash: hashToken(token),
      expiresAt,
      maxPerDay: EMAIL_CHANGE_MAX_PER_DAY,
    });
    if (requestId === null) {
      throw new HttpError(
        429,
        'Muitos pedidos de troca de e-mail hoje. Tente de novo amanhã.',
        'too_many_email_changes',
      );
    }

    void auditService.log({
      userId,
      action: 'email_change_requested',
      entityType: 'user',
      entityId: userId,
      newValue: { requestId, to: maskEmail(newEmail), blocked },
      ip: ctx.ip,
      userAgent: userAgentOf(ctx.userAgent),
    });
    // Os envios não seguram a resposta: o tempo dela não muda com o link indo ou não.
    const mails: Promise<unknown>[] = [];
    if (!blocked) {
      mails.push(
        mailService.send({
          userId,
          to: newEmail,
          template: 'email_change',
          vars: {
            link: appLink(`/confirmar-novo-email?token=${token}`),
            validity: `${env.EMAIL_VERIFY_TTL_HOURS} horas`,
          },
        }),
      );
    }
    // Aviso de segurança ao endereço atual: vai mesmo com os e-mails de novidades desligados.
    mails.push(
      mailService.send({
        userId,
        to: user.email,
        template: 'notification',
        vars: {
          title: 'Pedido para trocar o e-mail da sua conta',
          body: `Recebemos um pedido para trocar o e-mail de acesso da sua conta no Escambo para ${maskEmail(newEmail)}. Nada muda até o endereço novo confirmar pelo link que enviamos a ele. Se não foi você, alguém sabe a sua senha: redefina a senha agora, o que cancela o pedido e encerra as sessões abertas, e fale com o suporte.`,
          link: appLink('/esqueci-senha'),
          cta: 'Redefinir senha',
        },
      }),
    );
    void Promise.allSettled(mails);
    return { email: newEmail, expiresAt: expiresAt.toISOString() };
  },

  /** Desiste do pedido aberto (204 mesmo sem pedido: o estado final é o mesmo). */
  async cancelEmailChange(userId: number, ctx: RequestContext): Promise<void> {
    await cancelEmailChanges(userId, 'user', ctx);
  },

  /**
   * Confirma a troca pelo link (uso único, com validade). O e-mail novo entra já confirmado, os
   * links que tinham ido ao endereço antigo deixam de valer e todas as sessões caem. Se quem abriu
   * o link está logado nesta mesma conta, ganha uma sessão nova e segue dentro; as outras caem.
   * O endereço antigo recebe o aviso de que a troca aconteceu.
   */
  async confirmEmailChange(
    token: string,
    ctx: RequestContext,
    requesterId: number | undefined,
  ): Promise<ConfirmEmailChangeResponse> {
    const result = await emailChangeRepository.confirm(hashToken(token), assertCanConfirm);
    if (result.kind === 'invalid') {
      throw new HttpError(400, 'Link inválido ou vencido', 'invalid_token');
    }
    if (result.kind === 'taken') throw new HttpError(409, UNAVAILABLE_MESSAGE, 'email_unavailable');

    const userAgent = userAgentOf(ctx.userAgent);
    void auditService.log({
      userId: result.userId,
      action: 'email_changed',
      entityType: 'user',
      entityId: result.userId,
      oldValue: { email: maskEmail(result.oldEmail) },
      newValue: {
        email: maskEmail(result.newEmail),
        requestId: result.requestId,
        sessionsRevoked: result.sessionsRevoked,
      },
      ip: ctx.ip,
      userAgent,
    });
    void mailService.send({
      userId: result.userId,
      to: result.oldEmail,
      template: 'notification',
      vars: {
        title: 'O e-mail da sua conta foi trocado',
        body: `O e-mail de acesso da sua conta no Escambo agora é ${maskEmail(result.newEmail)}, confirmado pelo link enviado a ele, e as sessões abertas foram encerradas. Se não foi você, procure o suporte do Escambo com urgência e informe este endereço: a conta não entra mais por ele.`,
        link: appLink('/'),
        cta: 'Abrir o Escambo',
      },
    });

    let session: ConfirmEmailChangeResponse['session'] = null;
    if (requesterId === result.userId) {
      const user = await authRepository.findById(result.userId);
      if (user) session = await issueSession(user, ctx);
    }
    return { email: result.newEmail, session };
  },

  /** Grava (ou apaga, com null) o telefone já normalizado em E.164 e devolve o contato. */
  async updatePhone(
    userId: number,
    phone: string | null,
    ctx: RequestContext,
  ): Promise<AccountContact> {
    await authRepository.updatePhone(userId, phone);
    void auditService.log({
      userId,
      action: 'phone_changed',
      entityType: 'user',
      entityId: userId,
      newValue: { informed: phone !== null },
      ip: ctx.ip,
      userAgent: userAgentOf(ctx.userAgent),
    });
    return this.get(userId);
  },
};
