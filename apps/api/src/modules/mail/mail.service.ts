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
  'contract_expired',
  'contract_overdue',
  'deadline_extension_requested',
  'deadline_extension_accepted',
  'deadline_extension_declined',
  'milestone_delivered',
  'milestone_approved',
  'milestone_revision',
  'milestone_overdue',
  'saved_search_match',
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
  'content_removed',
  'appeal_decided',
]);

/** Para onde o e-mail de notificação aponta, a partir dos dados da notificação. */
export function notificationLink(data: Record<string, unknown> | null | undefined): string {
  const base = env.APP_URL.replace(/\/$/, '');
  const contractId = data?.contractId;
  if (typeof contractId === 'number') return `${base}/contratos/${contractId}`;
  if (data?.barterId != null) return `${base}/trocas`;
  if (data?.withdrawalId != null || data?.paymentId != null) return `${base}/carteira`;
  if (
    data?.exportRequestId != null ||
    data?.deletionRequestId != null ||
    data?.contentRemoved != null ||
    data?.imageRemovalId != null ||
    data?.removalId != null
  )
    return `${base}/perfil`;
  // Alerta de busca salva (ADR 35): o link reaplica a busca na tela de serviços.
  if (typeof data?.savedSearchId === 'number')
    return `${base}/servicos?busca=${data.savedSearchId}`;
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
   * Devolve o id na caixa de saída, ou null se o envio está desligado. Quem precisa saber se o
   * provedor aceitou usa `deliver`: o id existe mesmo quando o envio falhou.
   */
  async send(params: {
    userId: number | null;
    to: string;
    template: MailTemplate;
    vars: TemplateVars;
  }): Promise<number | null> {
    return (await this.deliver(params)).id;
  },

  /** Como `send`, dizendo também se o provedor aceitou a mensagem (ADR 55). */
  async deliver(params: {
    userId: number | null;
    to: string;
    template: MailTemplate;
    vars: TemplateVars;
  }): Promise<{ id: number | null; delivered: boolean }> {
    const provider = activeMailProvider();
    if (!provider) return { id: null, delivered: false };
    let id: number | null = null;
    let delivered = false;
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
        delivered = true;
      } catch (err) {
        logger.warn({ err, to: params.to, template: params.template }, 'envio de e-mail falhou');
        await mailRepository.markFailed(id, err instanceof Error ? err.message : String(err));
      }
      // O provedor aceitou: é entrega, mesmo que a caixa de saída não consiga registrar (senão
      // quem reenvia em falha — o relatório da moderação — mandaria de novo o que já saiu).
      if (delivered) {
        try {
          await mailRepository.markSent(id);
        } catch (err) {
          logger.warn(
            { err, template: params.template },
            'e-mail enviado, mas não marcado como enviado',
          );
        }
      }
    } catch (err) {
      logger.warn({ err, template: params.template }, 'não foi possível registrar o e-mail');
    }
    return { id, delivered };
  },

  async listRecent(limit: number, userId: number | null): Promise<AdminEmail[]> {
    return (await mailRepository.listRecent(limit, userId)).map(toAdminEmail);
  },
};
