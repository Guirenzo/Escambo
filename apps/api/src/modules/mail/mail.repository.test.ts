import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { mailRepository } from './mail.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Caixa de saída dos e-mails (email_outbox) sem banco: o que cada método pede e o que devolve.
 * Se o SQL roda no MySQL é assunto da integração.
 */
describe('mailRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('create grava o e-mail renderizado (texto e HTML) com o provedor e devolve o id da caixa de saída', async () => {
    const data = {
      userId: 7,
      to: 'ana@escambo.test',
      subject: 'Confirme seu e-mail',
      template: 'verify_email',
      text: 'Abra o link',
      html: '<p>Abra o link</p>',
      provider: 'simulated',
    };
    fakeDb.reply({ insertId: 31, affectedRows: 1 });

    expect(await mailRepository.create(data)).toBe(31);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'INSERT INTO email_outbox (user_id, to_email, subject, template, text_body, html_body, provider)',
    );
    expect(sql).toContain('VALUES (:userId, :to, :subject, :template, :text, :html, :provider)');
    expect(params).toEqual(data);
  });

  it('create aceita e-mail sem dono (userId null): o relatório da moderação não é de uma conta', async () => {
    fakeDb.reply({ insertId: 32, affectedRows: 1 });
    const data = {
      userId: null,
      to: 'root@escambo.test',
      subject: 's',
      template: 'moderation_report',
      text: 't',
      html: 'h',
      provider: 'smtp',
    };

    expect(await mailRepository.create(data)).toBe(32);
    expect(fakeDb.calls[0]!.params).toEqual(data);
  });

  it('markSent marca como enviado, com a hora, só aquele e-mail', async () => {
    fakeDb.reply({ affectedRows: 1 });

    await mailRepository.markSent(31);

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe(
      "UPDATE email_outbox SET status = 'sent', sent_at = NOW() WHERE id = :id",
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 31 });
  });

  it('markFailed guarda o motivo da falha, cortado em 500 caracteres para caber na coluna', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });

    await mailRepository.markFailed(31, 'SMTP 535');
    await mailRepository.markFailed(32, 'x'.repeat(700));

    expect(fakeDb.calls[0]!.sql).toBe(
      "UPDATE email_outbox SET status = 'failed', error = :error WHERE id = :id",
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 31, error: 'SMTP 535' });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 32, error: 'x'.repeat(500) });
  });

  describe('listRecent (caixa de saída do admin)', () => {
    it('traz os mais recentes primeiro, até o limite, sem o HTML do e-mail', async () => {
      const rows = [{ id: 9 }, { id: 8 }];
      fakeDb.reply(rows);

      expect(await mailRepository.listRecent(30, null)).toBe(rows);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'SELECT id, user_id, to_email, subject, template, text_body, status, provider, error, sent_at, created_at FROM email_outbox',
      );
      expect(sql).not.toContain('html_body');
      expect(sql).toContain('WHERE (:userId IS NULL OR user_id = :userId)');
      expect(sql).toContain('ORDER BY id DESC LIMIT 30');
      // Sem usuário, o filtro se desliga pelo próprio parâmetro nulo.
      expect(params).toEqual({ userId: null });
    });

    it('com um usuário, filtra pelos e-mails dele e respeita o limite pedido', async () => {
      fakeDb.reply([]);

      expect(await mailRepository.listRecent(5, 7)).toEqual([]);

      expect(fakeDb.calls[0]!.sql).toContain('ORDER BY id DESC LIMIT 5');
      expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
    });
  });

  it('deleteForUser apaga só os e-mails guardados daquele titular (LGPD)', async () => {
    fakeDb.reply({ affectedRows: 4 });

    await mailRepository.deleteForUser(7);

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe('DELETE FROM email_outbox WHERE user_id = :userId');
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
  });

  it('a falha do banco sobe para o service, que é quem decide não derrubar o fluxo', async () => {
    const down = new Error('ECONNREFUSED');
    fakeDb.reply(down);

    await expect(mailRepository.markSent(1)).rejects.toBe(down);
  });
});
