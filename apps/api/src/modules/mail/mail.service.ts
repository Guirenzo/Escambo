import type { AdminEmail } from '@escambo/types';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { activeMailProvider } from './mail.provider';
import { mailRepository, type OutboxRow } from './mail.repository';
import { renderEmail, type MailTemplate, type TemplateVars } from './mail.templates';

/** Notificações in-app que também vão por e-mail (chat e ruído de baixo valor ficam de fora). */
export const EMAILED_NOTIFICATION_TYPES = new Set([
  'contract_proposal',
  'contract_accepted',
  'contract_rejected',
  'contract_delivered',
  'contract_completed',
  'contract_revision',
  'contract_cancelled',
  'dispute_opened',
  'dispute_resolved',
  'barter_proposed',
  'barter_accepted',
  'barter_completed',
  'barter_disputed',
  'deposit_confirmed',
  'withdrawal_completed',
  'withdrawal_failed',
  'export_ready',
  'deletion_rejected',
  'review_received',
]);

/** Para onde o e-mail de notificação aponta, a partir dos dados da notificação. */
export function notificationLink(data: Record<string, unknown> | null | undefined): string {
  const base = env.APP_URL.replace(/\/$/, '');
  const contractId = data?.contractId;
  if (typeof contractId === 'number') return `${base}/contratos/${contractId}`;
  if (data?.barterId != null) return `${base}/trocas`;
  if (data?.withdrawalId != null || data?.paymentId != null) return `${base}/carteira`;
  if (data?.exportRequestId != null || data?.deletionRequestId != null) return `${base}/perfil`;
  return `${base}/notificacoes`;
}

function toAdminEmail(r: OutboxRow): AdminEmail {
  return {
    id: r.id,
    userId: r.user_id,
    to: r.to_email,
    subject: r.subject,
    template: r.template as MailTemplate,
    text: r.text_body,
    status: r.status as AdminEmail['status'],
    provider: r.provider,
    error: r.error,
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export const mailService = {
  /** Há provedor ativo? (MAIL_PROVIDER != off) */
  enabled(): boolean {
    return activeMailProvider() !== null;
  },

  /**
   * Renderiza, registra na caixa de saída e entrega pelo provedor ativo. Melhor esforço:
   * nunca lança (um e-mail que falhou não pode derrubar um cadastro ou um pagamento).
   * Devolve o id na caixa de saída, ou null se o envio está desligado.
   */
  async send(params: {
    userId: number | null;
    to: string;
    template: MailTemplate;
    vars: TemplateVars;
  }): Promise<number | null> {
    const provider = activeMailProvider();
    if (!provider) return null;
    let id: number | null = null;
    try {
      const mail = renderEmail(params.template, params.vars);
      id = await mailRepository.create({
        userId: params.userId,
        to: params.to,
        subject: mail.subject,
        template: params.template,
        text: mail.text,
        html: mail.html,
        provider: provider.name,
      });
      try {
        await provider.send({ to: params.to, ...mail });
        await mailRepository.markSent(id);
      } catch (err) {
        logger.warn({ err, to: params.to, template: params.template }, 'envio de e-mail falhou');
        await mailRepository.markFailed(id, err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      logger.warn({ err, template: params.template }, 'não foi possível registrar o e-mail');
    }
    return id;
  },

  async listRecent(limit: number, userId: number | null): Promise<AdminEmail[]> {
    return (await mailRepository.listRecent(limit, userId)).map(toAdminEmail);
  },
};
