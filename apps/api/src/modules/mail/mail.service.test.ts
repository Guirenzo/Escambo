import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./mail.repository', () => ({
  mailRepository: {
    create: vi.fn().mockResolvedValue(11),
    markSent: vi.fn(),
    markFailed: vi.fn(),
    listRecent: vi.fn(),
    deleteForUser: vi.fn(),
  },
}));
vi.mock('./mail.provider', () => ({
  activeMailProvider: vi.fn(),
}));

import { env } from '../../config/env';
import { activeMailProvider, type MailProvider } from './mail.provider';
import { mailRepository } from './mail.repository';
import { EMAILED_NOTIFICATION_TYPES, mailService, notificationLink } from './mail.service';
import { renderEmail } from './mail.templates';

const repo = vi.mocked(mailRepository);
const provider = vi.mocked(activeMailProvider);

beforeEach(() => vi.clearAllMocks());

describe('templates', () => {
  it('confirmação e redefinição levam o link no texto e no HTML, com HTML escapado', () => {
    const v = renderEmail('verify_email', { link: 'http://app/verificar-email?token=T<1>' });
    expect(v.subject).toBe('Confirme seu e-mail no Escambo');
    expect(v.text).toContain('http://app/verificar-email?token=T<1>');
    expect(v.html).toContain('href="http://app/verificar-email?token=T&lt;1&gt;"');
    const r = renderEmail('password_reset', { link: 'http://app/redefinir-senha?token=abc' });
    expect(r.text).toContain('só pode ser usado uma vez');
    const n = renderEmail('notification', {
      title: 'Nova proposta',
      body: 'Landing page',
      link: 'http://app/contratos/9',
    });
    expect(n.subject).toBe('Nova proposta');
    expect(n.html).toContain('Abrir no Escambo');
  });

  it('link da notificação aponta para a tela certa', () => {
    expect(notificationLink({ contractId: 9 })).toBe(`${env.APP_URL}/contratos/9`);
    expect(notificationLink({ barterId: 2 })).toBe(`${env.APP_URL}/trocas`);
    expect(notificationLink({ withdrawalId: 3 })).toBe(`${env.APP_URL}/carteira`);
    expect(notificationLink({ exportRequestId: 1 })).toBe(`${env.APP_URL}/perfil`);
    expect(notificationLink(null)).toBe(`${env.APP_URL}/notificacoes`);
    expect(EMAILED_NOTIFICATION_TYPES.has('chat_message')).toBe(false);
    expect(EMAILED_NOTIFICATION_TYPES.has('contract_proposal')).toBe(true);
  });
});

describe('mailService.send', () => {
  const fake = (send: MailProvider['send']): MailProvider => ({ name: 'simulated', send });

  it('registra na caixa de saída, entrega pelo provedor e marca como enviado', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    provider.mockReturnValue(fake(send));
    const id = await mailService.send({
      userId: 1,
      to: 'ana@escambo.test',
      template: 'verify_email',
      vars: { link: 'http://app/v?token=x' },
    });
    expect(id).toBe(11);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        to: 'ana@escambo.test',
        template: 'verify_email',
        provider: 'simulated',
      }),
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ana@escambo.test' }));
    expect(repo.markSent).toHaveBeenCalledWith(11);
  });

  it('provedor falhou: fica registrado como falha e não lança', async () => {
    provider.mockReturnValue(fake(vi.fn().mockRejectedValue(new Error('SMTP 535'))));
    await expect(
      mailService.send({ userId: 1, to: 'a@b.c', template: 'notification', vars: { title: 'x' } }),
    ).resolves.toBe(11);
    expect(repo.markFailed).toHaveBeenCalledWith(11, 'SMTP 535');
  });

  it('provedor desligado: não registra nem envia', async () => {
    provider.mockReturnValue(null);
    await expect(
      mailService.send({ userId: 1, to: 'a@b.c', template: 'notification', vars: { title: 'x' } }),
    ).resolves.toBeNull();
    expect(repo.create).not.toHaveBeenCalled();
  });
});
