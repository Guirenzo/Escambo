import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/**
 * Provedor de e-mail atrás de interface (mesmo desenho do gateway de pagamento).
 * - `simulated`: nada sai da máquina; a caixa de saída (email_outbox) é a entrega — o admin
 *   lê os e-mails no painel e a demo/os testes pegam os links de lá.
 * - `smtp`: nodemailer com SMTP_* (qualquer provedor: Gmail, SES, Mailgun, Resend…).
 * - `off`: não registra nem envia (testes unitários).
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailProvider {
  readonly name: 'simulated' | 'smtp';
  send(message: MailMessage): Promise<void>;
}

export const simulatedProvider: MailProvider = {
  name: 'simulated',
  async send(message) {
    logger.info({ to: message.to, subject: message.subject }, 'e-mail (simulado) entregue');
  },
};

let transporter: Transporter | null = null;

export const smtpProvider: MailProvider = {
  name: 'smtp',
  async send(message) {
    if (!env.SMTP_HOST) throw new Error('SMTP_HOST não configurado');
    transporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    await transporter.sendMail({ from: env.MAIL_FROM, ...message });
  },
};

/** Provedor ativo (MAIL_PROVIDER); null quando desligado. */
export function activeMailProvider(): MailProvider | null {
  if (env.MAIL_PROVIDER === 'off') return null;
  return env.MAIL_PROVIDER === 'smtp' ? smtpProvider : simulatedProvider;
}
