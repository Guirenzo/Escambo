import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createTransport, sendMail } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { activeMailProvider, simulatedProvider, smtpProvider } from './mail.provider';

const message = {
  to: 'ana@escambo.test',
  subject: 'Confirme seu e-mail',
  text: 'Abra o link',
  html: '<p>Abra o link</p>',
};

/**
 * O transporte SMTP fica guardado no módulo depois do primeiro envio. Para conferir como ele é
 * aberto em cada configuração, o módulo é carregado de novo com o ambiente já ajustado (o
 * nodemailer continua sendo o falso: nenhum e-mail sai da máquina).
 */
async function freshSmtp(patch: Partial<typeof env>) {
  vi.resetModules();
  const fresh = await import('../../config/env');
  Object.assign(fresh.env, patch);
  return (await import('./mail.provider')).smtpProvider;
}

const original = { provider: env.MAIL_PROVIDER, host: env.SMTP_HOST };

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue({ messageId: 'x' });
});

afterEach(() => {
  env.MAIL_PROVIDER = original.provider;
  env.SMTP_HOST = original.host;
  vi.restoreAllMocks();
});

/** Provedores de e-mail atrás da interface: o simulado não sai da máquina, o SMTP usa SMTP_*. */
describe('provedores de e-mail', () => {
  it('simulado: nada sai da máquina, e o log leva só destinatário e assunto (nunca o corpo)', async () => {
    const info = vi.spyOn(logger, 'info');

    await expect(simulatedProvider.send(message)).resolves.toBeUndefined();

    expect(simulatedProvider.name).toBe('simulated');
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      { to: 'ana@escambo.test', subject: 'Confirme seu e-mail' },
      'e-mail (simulado) entregue',
    );
  });

  it('smtp sem SMTP_HOST: recusa com mensagem clara e nem abre o transporte', async () => {
    env.SMTP_HOST = '';

    await expect(smtpProvider.send(message)).rejects.toThrow('SMTP_HOST não configurado');

    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('smtp: abre o transporte com host, porta, TLS e credenciais do ambiente e envia com o remetente MAIL_FROM', async () => {
    const smtp = await freshSmtp({
      SMTP_HOST: 'smtp.escambo.test',
      SMTP_PORT: 465,
      SMTP_SECURE: true,
      SMTP_USER: 'carteiro',
      SMTP_PASS: 'segredo-de-teste',
      MAIL_FROM: 'Escambo <avisos@escambo.test>',
    });

    await smtp.send(message);

    expect(smtp.name).toBe('smtp');
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.escambo.test',
      port: 465,
      secure: true,
      auth: { user: 'carteiro', pass: 'segredo-de-teste' },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Escambo <avisos@escambo.test>',
      to: 'ana@escambo.test',
      subject: 'Confirme seu e-mail',
      text: 'Abra o link',
      html: '<p>Abra o link</p>',
    });
  });

  it('smtp sem usuário: o transporte vai sem autenticação (relay interno)', async () => {
    const smtp = await freshSmtp({ SMTP_HOST: 'relay.escambo.test', SMTP_USER: '', SMTP_PASS: '' });

    await smtp.send(message);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'relay.escambo.test', auth: undefined }),
    );
  });

  it('smtp: o transporte é aberto uma vez e reaproveitado nos envios seguintes', async () => {
    const smtp = await freshSmtp({ SMTP_HOST: 'smtp.escambo.test' });

    await smtp.send(message);
    await smtp.send({ ...message, to: 'bia@escambo.test' });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail.mock.calls.map((c) => (c[0] as { to: string }).to)).toEqual([
      'ana@escambo.test',
      'bia@escambo.test',
    ]);
  });

  it('smtp: a recusa do servidor sobe para quem chamou (é o service que registra a falha)', async () => {
    const smtp = await freshSmtp({ SMTP_HOST: 'smtp.escambo.test' });
    const refused = new Error('SMTP 535 autenticação recusada');
    sendMail.mockRejectedValue(refused);

    await expect(smtp.send(message)).rejects.toBe(refused);
  });

  it('activeMailProvider segue MAIL_PROVIDER: off não tem provedor, smtp é o real, o resto é o simulado', () => {
    env.MAIL_PROVIDER = 'off';
    expect(activeMailProvider()).toBeNull();
    env.MAIL_PROVIDER = 'smtp';
    expect(activeMailProvider()).toBe(smtpProvider);
    env.MAIL_PROVIDER = 'simulated';
    expect(activeMailProvider()).toBe(simulatedProvider);
  });
});
