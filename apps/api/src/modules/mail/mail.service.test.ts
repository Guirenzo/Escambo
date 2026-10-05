import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { logger } from '../../config/logger';
import { activeMailProvider, type MailProvider } from './mail.provider';
import { mailRepository } from './mail.repository';
import { EMAILED_NOTIFICATION_TYPES, mailService, notificationLink } from './mail.service';
import { renderEmail } from './mail.templates';

const repo = vi.mocked(mailRepository);
const provider = vi.mocked(activeMailProvider);

beforeEach(() => vi.clearAllMocks());
// Só desfaz os vi.spyOn (o log); os falsos do repository continuam com o que o vi.mock deu.
afterEach(() => vi.restoreAllMocks());

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

  it('relatório da moderação leva os parágrafos prontos e o botão do painel (ADR 55)', () => {
    const m = renderEmail('moderation_report', {
      title: 'Moderação: ontem (23/09) a fila passou da meta de 24 h',
      paragraphs: [
        'Ontem (23/09) entraram 4 denúncias & a fila decidiu 3.',
        'Agora a fila está vazia.',
      ],
      link: 'http://app.escambo.test/admin#health-title',
    });
    expect(m.subject).toBe('Moderação: ontem (23/09) a fila passou da meta de 24 h');
    expect(m.text).toContain('entraram 4 denúncias & a fila decidiu 3.');
    expect(m.text).toContain('http://app.escambo.test/admin#health-title');
    expect(m.html).toContain('denúncias &amp; a fila');
    expect(m.html).toContain('Ver painel');
    expect(m.html).toContain('href="http://app.escambo.test/admin#health-title"');
  });

  it('resumo diário lista cada novidade e leva para as notificações', () => {
    const mail = renderEmail('digest', {
      items: [
        {
          title: 'Nova proposta',
          body: 'Site institucional',
          link: 'http://app.escambo.test/contratos/9',
        },
        { title: 'Extensão aceita', body: null, link: 'http://app.escambo.test/contratos/9' },
      ],
    });
    expect(mail.subject).toBe('Seu resumo do dia: 2 novidades no Escambo');
    expect(mail.text).toContain('• Nova proposta — Site institucional');
    expect(mail.text).toContain('• Extensão aceita');
    expect(mail.text).toContain('/notificacoes');
    expect(mail.html).toContain('Ver notificações');
    expect(renderEmail('digest', { items: [{ title: 'x', body: null, link: 'l' }] }).subject).toBe(
      'Seu resumo do dia: 1 novidade no Escambo',
    );
  });

  it('validade do link: 24 horas na confirmação e 1 hora na redefinição por padrão, ou a que o chamador informar', () => {
    const link = 'http://app/x?token=abc';
    expect(renderEmail('verify_email', { link }).text).toContain('O link vale por 24 horas.');
    expect(renderEmail('password_reset', { link }).text).toContain('O link vale por 1 hora e');
    expect(renderEmail('verify_email', { link, validity: '48 horas' }).text).toContain(
      'O link vale por 48 horas.',
    );
    expect(renderEmail('password_reset', { link, validity: '30 minutos' }).html).toContain(
      'O link vale por 30 minutos e',
    );
    expect(renderEmail('password_reset', { link }).subject).toBe('Redefinição de senha no Escambo');
    expect(renderEmail('password_reset', { link }).html).toContain('Criar nova senha');
    expect(renderEmail('verify_email', { link }).html).toContain('Confirmar e-mail');
  });

  it('sem link, título ou itens, cada template cai no padrão: o botão leva ao app, ao painel ou às notificações', () => {
    const base = env.APP_URL.replace(/\/$/, '');
    for (const template of ['verify_email', 'password_reset', 'notification'] as const) {
      expect(renderEmail(template, {}).html, template).toContain(`href="${env.APP_URL}"`);
    }
    const notification = renderEmail('notification', {});
    expect(notification.subject).toBe('Novidade no Escambo');
    // Sem corpo, o texto é só o título, o link e a assinatura.
    expect(notification.text).toBe(
      ['Novidade no Escambo', '', '', env.APP_URL, '', `Escambo · ${env.APP_URL}`].join('\n'),
    );
    const custom = renderEmail('notification', { title: 't', body: 'Corpo', cta: 'Ver proposta' });
    expect(custom.html).toContain('Ver proposta');
    expect(custom.html).not.toContain('Abrir no Escambo');
    expect(custom.text).toContain('\nCorpo\n');

    const report = renderEmail('moderation_report', {});
    expect(report.subject).toBe('Relatório da moderação');
    expect(report.html).toContain(`href="${base}/admin"`);

    const digest = renderEmail('digest', {});
    expect(digest.subject).toBe('Seu resumo do dia: 0 novidades no Escambo');
    expect(digest.html).toContain(`href="${base}/notificacoes"`);
    expect(renderEmail('digest', { link: 'http://app/outro' }).html).toContain(
      'href="http://app/outro"',
    );
  });

  it('o HTML escapa aspas e sinais no título, no corpo e no link (nada do usuário vira marcação)', () => {
    const mail = renderEmail('notification', {
      title: 'Proposta <b>"urgente"</b>',
      body: 'Tom & Ana <script>alert(1)</script>',
      link: 'http://app/c?a=1&b="x"',
    });
    expect(mail.html).toContain('Proposta &lt;b&gt;&quot;urgente&quot;&lt;/b&gt;');
    expect(mail.html).toContain('Tom &amp; Ana &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).toContain('href="http://app/c?a=1&amp;b=&quot;x&quot;"');
    expect(mail.html).not.toContain('<script>');
    // O texto puro vai como foi escrito.
    expect(mail.text).toContain('Tom & Ana <script>alert(1)</script>');
    expect(mail.subject).toBe('Proposta <b>"urgente"</b>');
  });

  it('link da notificação aponta para a tela certa', () => {
    expect(notificationLink({ contractId: 9 })).toBe(`${env.APP_URL}/contratos/9`);
    expect(notificationLink({ barterId: 2 })).toBe(`${env.APP_URL}/trocas`);
    expect(notificationLink({ withdrawalId: 3 })).toBe(`${env.APP_URL}/carteira`);
    expect(notificationLink({ exportRequestId: 1 })).toBe(`${env.APP_URL}/perfil`);
    expect(notificationLink({ removalId: 4, decision: 'upheld' })).toBe(`${env.APP_URL}/perfil`);
    // Notificações antigas de imagem ainda levam ao perfil.
    expect(notificationLink({ imageRemovalId: 4 })).toBe(`${env.APP_URL}/perfil`);
    expect(notificationLink(null)).toBe(`${env.APP_URL}/notificacoes`);
    expect(EMAILED_NOTIFICATION_TYPES.has('chat_message')).toBe(false);
    expect(EMAILED_NOTIFICATION_TYPES.has('contract_proposal')).toBe(true);
    expect(EMAILED_NOTIFICATION_TYPES.has('appeal_decided')).toBe(true);
  });

  it('os lembretes, a revisão parada e a aprovação automática (ADR 58) vão por e-mail, e o conjunto tem 38 tipos', () => {
    for (const type of [
      'contract_proposal_reminder',
      'contract_deadline_reminder',
      'contract_approval_reminder',
      'contract_extension_reminder',
      'contract_revision_stalled',
      'contract_auto_approved',
    ]) {
      expect(EMAILED_NOTIFICATION_TYPES.has(type)).toBe(true);
    }
    // Tipo novo entra de propósito: o push (QUIET_PASS_BY_TYPE) e o resumo dependem deste conjunto.
    expect(EMAILED_NOTIFICATION_TYPES.size).toBe(38);
    // O lembrete leva à contratação, como os outros avisos dela.
    expect(notificationLink({ contractId: 3 })).toBe(`${env.APP_URL}/contratos/3`);
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
    // Falha não é envio: a linha da caixa de saída não pode aparecer como enviada.
    expect(repo.markSent).not.toHaveBeenCalled();
  });

  it('deliver diz se o provedor aceitou; send é o atalho que devolve só o id (ADR 55)', async () => {
    provider.mockReturnValue(fake(vi.fn().mockResolvedValue(undefined)));
    await expect(
      mailService.deliver({
        userId: 1,
        to: 'a@b.c',
        template: 'notification',
        vars: { title: 'x' },
      }),
    ).resolves.toEqual({ id: 11, delivered: true });
    provider.mockReturnValue(fake(vi.fn().mockRejectedValue(new Error('SMTP 535'))));
    await expect(
      mailService.deliver({
        userId: 1,
        to: 'a@b.c',
        template: 'notification',
        vars: { title: 'x' },
      }),
    ).resolves.toEqual({ id: 11, delivered: false });
    provider.mockReturnValue(null);
    await expect(
      mailService.deliver({
        userId: 1,
        to: 'a@b.c',
        template: 'notification',
        vars: { title: 'x' },
      }),
    ).resolves.toEqual({ id: null, delivered: false });
  });

  it('provedor aceitou e a caixa de saída falhou ao marcar: é entrega, não falha (ADR 55)', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const dropped = new Error('conexão caiu');
    provider.mockReturnValue(fake(vi.fn().mockResolvedValue(undefined)));
    repo.markSent.mockRejectedValueOnce(dropped);
    await expect(
      mailService.deliver({
        userId: 1,
        to: 'a@b.c',
        template: 'notification',
        vars: { title: 'x' },
      }),
    ).resolves.toEqual({ id: 11, delivered: true });
    expect(repo.markSent).toHaveBeenCalledWith(11);
    expect(repo.markFailed).not.toHaveBeenCalled();
    // O log diz o que houve de verdade: saiu, só não ficou marcado (não é "não registrou").
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { err: dropped, template: 'notification' },
      'e-mail enviado, mas não marcado como enviado',
    );
  });

  it('provedor desligado: não registra nem envia', async () => {
    provider.mockReturnValue(null);
    await expect(
      mailService.send({ userId: 1, to: 'a@b.c', template: 'notification', vars: { title: 'x' } }),
    ).resolves.toBeNull();
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('link da notificação: os destinos que faltavam', () => {
  it('alerta de busca salva reaplica a busca na tela de serviços (ADR 35)', () => {
    expect(notificationLink({ savedSearchId: 5 })).toBe(`${env.APP_URL}/servicos?busca=5`);
    // Só um id numérico vira parâmetro da URL; qualquer outra coisa cai na lista de notificações.
    expect(notificationLink({ savedSearchId: '5' })).toBe(`${env.APP_URL}/notificacoes`);
  });

  it('só o id numérico da contratação entra no endereço do e-mail; texto no lugar do id segue para o próximo assunto', () => {
    expect(notificationLink({ contractId: '9' })).toBe(`${env.APP_URL}/notificacoes`);
    expect(notificationLink({ contractId: '9/../admin', barterId: 2 })).toBe(
      `${env.APP_URL}/trocas`,
    );
    expect(notificationLink({ contractId: { id: 9 } })).toBe(`${env.APP_URL}/notificacoes`);
  });

  it('pagamento leva à carteira; exclusão de conta e conteúdo removido levam ao perfil', () => {
    expect(notificationLink({ paymentId: 8 })).toBe(`${env.APP_URL}/carteira`);
    expect(notificationLink({ deletionRequestId: 2 })).toBe(`${env.APP_URL}/perfil`);
    expect(notificationLink({ contentRemoved: 'service' })).toBe(`${env.APP_URL}/perfil`);
    expect(notificationLink(undefined)).toBe(`${env.APP_URL}/notificacoes`);
  });

  it('campo que veio nulo não conta como assunto: o link segue para o próximo, ou para a lista', () => {
    expect(notificationLink({ contractId: null, barterId: 2 })).toBe(`${env.APP_URL}/trocas`);
    expect(notificationLink({ barterId: null, withdrawalId: 3 })).toBe(`${env.APP_URL}/carteira`);
    expect(notificationLink({ withdrawalId: null, paymentId: null, exportRequestId: 1 })).toBe(
      `${env.APP_URL}/perfil`,
    );
    expect(
      notificationLink({
        barterId: null,
        withdrawalId: null,
        paymentId: null,
        exportRequestId: null,
        deletionRequestId: null,
        contentRemoved: null,
        imageRemovalId: null,
        removalId: null,
      }),
    ).toBe(`${env.APP_URL}/notificacoes`);
    expect(notificationLink({})).toBe(`${env.APP_URL}/notificacoes`);
  });

  it('troca manda sobre carteira, carteira sobre perfil e perfil sobre a busca salva', () => {
    expect(notificationLink({ barterId: 2, paymentId: 8 })).toBe(`${env.APP_URL}/trocas`);
    expect(notificationLink({ withdrawalId: 3, removalId: 4 })).toBe(`${env.APP_URL}/carteira`);
    expect(notificationLink({ removalId: 4, savedSearchId: 5 })).toBe(`${env.APP_URL}/perfil`);
  });

  it('a contratação manda sobre os outros assuntos, e a barra final de APP_URL não duplica', () => {
    const original = env.APP_URL;
    env.APP_URL = 'http://app.escambo.test/';
    try {
      expect(notificationLink({ contractId: 9, barterId: 2, withdrawalId: 3 })).toBe(
        'http://app.escambo.test/contratos/9',
      );
      expect(notificationLink({ barterId: 2, withdrawalId: 3 })).toBe(
        'http://app.escambo.test/trocas',
      );
    } finally {
      env.APP_URL = original;
    }
  });
});

describe('mailService: registro, falhas e caixa de saída do admin', () => {
  const fake = (send: MailProvider['send']): MailProvider => ({ name: 'smtp', send });
  const params = {
    userId: 7,
    to: 'ana@escambo.test',
    template: 'notification' as const,
    vars: { title: 'Nova proposta', body: 'Landing page', link: 'http://app/contratos/9' },
  };

  it('enabled diz se há provedor ativo (MAIL_PROVIDER diferente de off)', () => {
    provider.mockReturnValue(fake(vi.fn()));
    expect(mailService.enabled()).toBe(true);
    provider.mockReturnValue(null);
    expect(mailService.enabled()).toBe(false);
  });

  it('o que vai para a caixa de saída e para o provedor é o e-mail renderizado, com o nome do provedor', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    provider.mockReturnValue(fake(send));
    const mail = renderEmail('notification', params.vars);

    await mailService.deliver(params);

    expect(repo.create).toHaveBeenCalledWith({
      userId: 7,
      to: 'ana@escambo.test',
      subject: mail.subject,
      template: 'notification',
      text: mail.text,
      html: mail.html,
      provider: 'smtp',
    });
    expect(send).toHaveBeenCalledWith({
      to: 'ana@escambo.test',
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  });

  it('se a caixa de saída não registra, nada é enviado e quem chamou não recebe erro', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const down = new Error('banco fora');
    const send = vi.fn();
    provider.mockReturnValue(fake(send));
    repo.create.mockRejectedValueOnce(down);

    await expect(mailService.deliver(params)).resolves.toEqual({ id: null, delivered: false });
    repo.create.mockRejectedValueOnce(down);
    await expect(mailService.send(params)).resolves.toBeNull();

    expect(send).not.toHaveBeenCalled();
    expect(repo.markSent).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
    // A falha não some: fica no log, uma vez por tentativa, com o template (e sem o destinatário).
    expect(warn.mock.calls).toEqual([
      [{ err: down, template: 'notification' }, 'não foi possível registrar o e-mail'],
      [{ err: down, template: 'notification' }, 'não foi possível registrar o e-mail'],
    ]);
  });

  it('erro ao montar o e-mail (template que não existe) também não derruba quem chamou: nada é gravado nem enviado', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const send = vi.fn();
    provider.mockReturnValue(fake(send));

    await expect(
      mailService.deliver({ ...params, template: 'nao_existe' as never }),
    ).resolves.toEqual({ id: null, delivered: false });

    expect(repo.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(TypeError), template: 'nao_existe' },
      'não foi possível registrar o e-mail',
    );
  });

  it('provedor recusou: o id da caixa de saída volta mesmo assim, para a trilha da falha', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const refused = new Error('SMTP 550 caixa inexistente');
    const send = vi.fn().mockRejectedValue(refused);
    provider.mockReturnValue(fake(send));
    repo.create.mockResolvedValueOnce(77);

    await expect(mailService.send(params)).resolves.toBe(77);

    // A falha é anotada na linha que acabou de ser criada (77), não em outra.
    expect(repo.markFailed.mock.calls).toEqual([[77, 'SMTP 550 caixa inexistente']]);
    expect(repo.markSent).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      [
        { err: refused, to: 'ana@escambo.test', template: 'notification' },
        'envio de e-mail falhou',
      ],
    ]);
  });

  it('falha do provedor que não é um Error fica registrada como texto, e o e-mail não conta como entregue', async () => {
    provider.mockReturnValue(fake(vi.fn().mockRejectedValue('tempo esgotado')));

    await expect(mailService.deliver(params)).resolves.toEqual({ id: 11, delivered: false });

    expect(repo.markFailed).toHaveBeenCalledWith(11, 'tempo esgotado');
    expect(repo.markSent).not.toHaveBeenCalled();
  });

  it('provedor falhou e nem a falha coube na caixa de saída: não lança, o id existe e o log diz que a falha não foi anotada (não que o e-mail não foi registrado)', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const refused = new Error('SMTP 535');
    const dropped = new Error('conexão caiu');
    provider.mockReturnValue(fake(vi.fn().mockRejectedValue(refused)));
    repo.markFailed.mockRejectedValueOnce(dropped);

    await expect(mailService.deliver(params)).resolves.toEqual({ id: 11, delivered: false });

    expect(repo.markFailed).toHaveBeenCalledWith(11, 'SMTP 535');
    expect(repo.markSent).not.toHaveBeenCalled();
    // As duas falhas ficam no log: a do provedor (com o destinatário) e a da caixa de saída, com
    // o id da linha que ficou com o status inicial.
    expect(warn.mock.calls).toEqual([
      [
        { err: refused, to: 'ana@escambo.test', template: 'notification' },
        'envio de e-mail falhou',
      ],
      [
        { err: dropped, id: 11, template: 'notification' },
        'e-mail não enviado, e a falha não foi anotada na caixa de saída',
      ],
    ]);
  });

  it('a ordem é registrar, enviar e só então marcar como enviado; entrega certa não deixa aviso no log', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const order: string[] = [];
    repo.create.mockImplementationOnce(async () => {
      order.push('create');
      return 12;
    });
    repo.markSent.mockImplementationOnce(async () => {
      order.push('markSent');
    });
    provider.mockReturnValue(
      fake(async () => {
        order.push('send');
      }),
    );

    await expect(mailService.deliver(params)).resolves.toEqual({ id: 12, delivered: true });

    // O id da caixa de saída é a trilha: existe antes de qualquer coisa sair da máquina.
    expect(order).toEqual(['create', 'send', 'markSent']);
    expect(repo.markSent).toHaveBeenCalledWith(12);
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('com o envio desligado, deliver não toca na caixa de saída', async () => {
    provider.mockReturnValue(null);

    await expect(mailService.deliver(params)).resolves.toEqual({ id: null, delivered: false });

    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.markSent).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('caixa de saída vazia: o painel recebe lista vazia, com o limite e o filtro repassados', async () => {
    repo.listRecent.mockResolvedValue([]);

    expect(await mailService.listRecent(10, null)).toEqual([]);

    expect(repo.listRecent).toHaveBeenCalledWith(10, null);
  });

  it('listRecent repassa o limite e o usuário e devolve os e-mails no formato do painel', async () => {
    repo.listRecent.mockResolvedValue([
      {
        id: 3,
        user_id: 7,
        to_email: 'ana@escambo.test',
        subject: 'Confirme seu e-mail',
        template: 'verify_email',
        text_body: 'Abra o link',
        status: 'sent',
        provider: 'simulated',
        error: null,
        sent_at: new Date('2026-09-15T12:00:05Z'),
        created_at: new Date('2026-09-15T12:00:00Z'),
      },
      {
        id: 2,
        user_id: null,
        to_email: 'root@escambo.test',
        subject: 'Moderação',
        template: 'moderation_report',
        text_body: 'Fila',
        status: 'failed',
        provider: 'smtp',
        error: 'SMTP 535',
        sent_at: null,
        created_at: '2026-09-14T08:00:00Z',
      },
    ] as never);

    const emails = await mailService.listRecent(30, 7);

    expect(repo.listRecent).toHaveBeenCalledWith(30, 7);
    expect(emails).toEqual([
      {
        id: 3,
        userId: 7,
        to: 'ana@escambo.test',
        subject: 'Confirme seu e-mail',
        template: 'verify_email',
        text: 'Abra o link',
        status: 'sent',
        provider: 'simulated',
        error: null,
        sentAt: '2026-09-15T12:00:05.000Z',
        createdAt: '2026-09-15T12:00:00.000Z',
      },
      {
        id: 2,
        userId: null,
        to: 'root@escambo.test',
        subject: 'Moderação',
        template: 'moderation_report',
        text: 'Fila',
        status: 'failed',
        provider: 'smtp',
        error: 'SMTP 535',
        // Ainda não saiu: sem data de envio, em vez de uma data inventada.
        sentAt: null,
        createdAt: '2026-09-14T08:00:00.000Z',
      },
    ]);
  });
});
