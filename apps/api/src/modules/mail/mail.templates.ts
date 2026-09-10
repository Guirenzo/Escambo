import { env } from '../../config/env';

/** Templates de e-mail em PT-BR: texto puro + HTML simples com a marca (sem imagens externas). */

export type MailTemplate = 'verify_email' | 'password_reset' | 'notification';

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export interface TemplateVars {
  /** Link principal (botão). */
  link?: string;
  title?: string;
  body?: string | null;
  /** Validade do link, em texto ("24 horas", "1 hora"). */
  validity?: string;
  /** Rótulo do botão. */
  cta?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout(
  title: string,
  paragraphs: string[],
  cta?: { label: string; link: string },
): string {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 14px;line-height:1.5">${esc(p)}</p>`)
    .join('');
  const button = cta
    ? `<p style="margin:22px 0"><a href="${esc(cta.link)}" style="display:inline-block;background:#0d5c3a;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">${esc(cta.label)}</a></p>
       <p style="margin:0 0 14px;font-size:12px;color:#566860">Se o botão não abrir, copie este endereço: <br>${esc(cta.link)}</p>`
    : '';
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f5f6f7;font-family:Inter,Segoe UI,Roboto,sans-serif;color:#0f1a14">
  <div style="max-width:560px;margin:0 auto;padding:28px 16px">
    <div style="font-weight:800;font-size:20px;color:#0d5c3a;margin-bottom:18px">&#8646; Escambo</div>
    <div style="background:#fff;border:1px solid #e4e9e6;border-radius:12px;padding:24px">
      <h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
      ${body}${button}
    </div>
    <p style="font-size:12px;color:#566860;margin:16px 0 0">Você recebeu este e-mail porque tem uma conta no Escambo. ${esc(env.APP_URL)}</p>
  </div></body></html>`;
}

const textOf = (title: string, paragraphs: string[], link?: string): string =>
  [title, '', ...paragraphs, ...(link ? ['', link] : []), '', `Escambo · ${env.APP_URL}`].join(
    '\n',
  );

export function renderEmail(template: MailTemplate, vars: TemplateVars): RenderedMail {
  switch (template) {
    case 'verify_email': {
      const title = 'Bem-vindo ao Escambo! Confirme seu e-mail';
      const paragraphs = [
        'Falta um passo: confirme que este e-mail é seu para receber avisos das suas contratações, trocas e pagamentos.',
        `O link vale por ${vars.validity ?? '24 horas'}. Se você não criou uma conta no Escambo, ignore esta mensagem.`,
      ];
      const link = vars.link ?? env.APP_URL;
      return {
        subject: 'Confirme seu e-mail no Escambo',
        text: textOf(title, paragraphs, link),
        html: layout(title, paragraphs, { label: 'Confirmar e-mail', link }),
      };
    }
    case 'password_reset': {
      const title = 'Redefinir sua senha';
      const paragraphs = [
        'Recebemos um pedido para redefinir a senha da sua conta no Escambo.',
        `O link vale por ${vars.validity ?? '1 hora'} e só pode ser usado uma vez. Se não foi você, ignore: sua senha continua a mesma.`,
      ];
      const link = vars.link ?? env.APP_URL;
      return {
        subject: 'Redefinição de senha no Escambo',
        text: textOf(title, paragraphs, link),
        html: layout(title, paragraphs, { label: 'Criar nova senha', link }),
      };
    }
    case 'notification': {
      const title = vars.title ?? 'Novidade no Escambo';
      const paragraphs = vars.body ? [vars.body] : [];
      const link = vars.link ?? env.APP_URL;
      return {
        subject: title,
        text: textOf(title, paragraphs, link),
        html: layout(title, paragraphs, { label: vars.cta ?? 'Abrir no Escambo', link }),
      };
    }
  }
}
