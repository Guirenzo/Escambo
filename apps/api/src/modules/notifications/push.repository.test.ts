import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { pushRepository } from './push.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/aparelho-1';

/**
 * Assinaturas de push por aparelho (ADR 52) sem banco: o que cada método pede e o que devolve.
 * Se o SQL roda no MySQL (inclusive o ON DUPLICATE KEY) é assunto da integração.
 */
describe('pushRepository', () => {
  beforeEach(() => fakeDb.reset());

  it('upsert grava a assinatura e, se o endpoint já existe, troca dono e chaves e limpa o erro; o navegador não é gravado (ADR 54)', async () => {
    const data = { userId: 7, endpoint: ENDPOINT, p256dh: 'chave-p256dh', auth: 'segredo' };
    fakeDb.reply({ affectedRows: 1 });

    await pushRepository.upsert(data);

    const { sql, params } = fakeDb.calls[0]!;
    expect(sql).toContain(
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_key) VALUES (:userId, :endpoint, :p256dh, :auth)',
    );
    expect(sql).toContain(
      'ON DUPLICATE KEY UPDATE user_id = :userId, p256dh = :p256dh, auth_key = :auth, last_error = NULL',
    );
    expect(sql).not.toContain('user_agent');
    expect(params).toEqual(data);
  });

  it('removeStale apaga quem não recebe nada há N dias (ou nunca recebeu, desde a criação) e devolve quantas', async () => {
    fakeDb.reply({ affectedRows: 3 });

    expect(await pushRepository.removeStale(90)).toBe(3);

    expect(fakeDb.calls[0]!.sql).toBe(
      'DELETE FROM push_subscriptions WHERE COALESCE(last_sent_at, created_at) < DATE_SUB(NOW(), INTERVAL :days DAY)',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ days: 90 });
  });

  it('listForUser traz os aparelhos da conta, com as chaves para o envio, em ordem de cadastro', async () => {
    const rows = [
      { id: 1, user_id: 7, endpoint: ENDPOINT, p256dh: 'p', auth_key: 'a' },
      { id: 2, user_id: 7, endpoint: `${ENDPOINT}-2`, p256dh: 'p2', auth_key: 'a2' },
    ];
    fakeDb.reply(rows);

    expect(await pushRepository.listForUser(7)).toBe(rows);

    expect(fakeDb.calls[0]!.sql).toBe(
      'SELECT id, user_id, endpoint, p256dh, auth_key FROM push_subscriptions WHERE user_id = :userId ORDER BY id',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
  });

  it('countForUser conta os aparelhos da conta e devolve número (0 sem linha)', async () => {
    fakeDb.reply([{ n: '2' }], []);

    expect(await pushRepository.countForUser(7)).toBe(2);
    expect(await pushRepository.countForUser(8)).toBe(0);

    expect(fakeDb.calls[0]!.sql).toBe(
      'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = :userId',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
  });

  it('belongsTo só é verdade quando o endpoint está assinado por esta conta (o navegador pode ter assinatura de outra)', async () => {
    fakeDb.reply([{ n: 1 }], [{ n: 0 }], []);

    expect(await pushRepository.belongsTo(7, ENDPOINT)).toBe(true);
    expect(await pushRepository.belongsTo(8, ENDPOINT)).toBe(false);
    expect(await pushRepository.belongsTo(9, ENDPOINT)).toBe(false);

    expect(fakeDb.calls[0]!.sql).toBe(
      'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = :userId AND endpoint = :endpoint',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, endpoint: ENDPOINT });
    expect(fakeDb.calls[1]!.params).toEqual({ userId: 8, endpoint: ENDPOINT });
  });

  it('remove só apaga o aparelho se ele é da conta, e diz se apagou', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

    expect(await pushRepository.remove(7, ENDPOINT)).toBe(true);
    // Endpoint de outra conta: nada é apagado, e a rota responde 404.
    expect(await pushRepository.remove(8, ENDPOINT)).toBe(false);

    expect(fakeDb.calls[0]!.sql).toBe(
      'DELETE FROM push_subscriptions WHERE user_id = :userId AND endpoint = :endpoint',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7, endpoint: ENDPOINT });
    expect(fakeDb.calls[1]!.params).toEqual({ userId: 8, endpoint: ENDPOINT });
  });

  it('removeAllForUser apaga todos os aparelhos da conta (sair de todos, trocar senha, encerrar) e devolve quantos', async () => {
    fakeDb.reply({ affectedRows: 2 });

    expect(await pushRepository.removeAllForUser(7)).toBe(2);

    expect(fakeDb.calls[0]!.sql).toBe('DELETE FROM push_subscriptions WHERE user_id = :userId');
    expect(fakeDb.calls[0]!.params).toEqual({ userId: 7 });
  });

  it('removeById apaga uma assinatura morta pelo id', async () => {
    fakeDb.reply({ affectedRows: 1 });

    await pushRepository.removeById(12);

    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.calls[0]!.sql).toBe('DELETE FROM push_subscriptions WHERE id = :id');
    expect(fakeDb.calls[0]!.params).toEqual({ id: 12 });
  });

  it('markSent registra a hora da entrega e limpa o erro anterior daquele aparelho', async () => {
    fakeDb.reply({ affectedRows: 1 });

    await pushRepository.markSent(12);

    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE push_subscriptions SET last_sent_at = NOW(), last_error = NULL WHERE id = :id',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 12 });
  });

  it('markError guarda o motivo, cortado em 255 caracteres, sem mexer na hora da última entrega', async () => {
    fakeDb.reply({ affectedRows: 1 }, { affectedRows: 1 });

    await pushRepository.markError(12, 'provedor webpush');
    await pushRepository.markError(13, 'e'.repeat(300));

    expect(fakeDb.calls[0]!.sql).toBe(
      'UPDATE push_subscriptions SET last_error = :error WHERE id = :id',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ id: 12, error: 'provedor webpush' });
    expect(fakeDb.calls[1]!.params).toEqual({ id: 13, error: 'e'.repeat(255) });
  });

  it('conta sem aparelho: lista vazia, e nada a apagar devolve zero', async () => {
    fakeDb.reply([], { affectedRows: 0 }, { affectedRows: 0 });

    expect(await pushRepository.listForUser(7)).toEqual([]);
    expect(await pushRepository.removeAllForUser(7)).toBe(0);
    expect(await pushRepository.removeStale(90)).toBe(0);
  });

  it('a falha do banco sobe para o service: remover não vira "não era seu" nem contar vira zero', async () => {
    const down = new Error('ECONNREFUSED');
    fakeDb.reply(down, down, down);

    await expect(pushRepository.remove(7, ENDPOINT)).rejects.toBe(down);
    await expect(pushRepository.countForUser(7)).rejects.toBe(down);
    await expect(pushRepository.belongsTo(7, ENDPOINT)).rejects.toBe(down);
  });

  describe('deliversWork (ADR 56)', () => {
    it('entrega trabalho quem é freelancer, tem algum serviço ou alguma contratação como freelancer', async () => {
      fakeDb.reply([{ d: 1 }]);

      expect(await pushRepository.deliversWork(7)).toBe(true);

      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain("SELECT (u.role = 'freelancer'");
      expect(sql).toContain('OR EXISTS (SELECT 1 FROM services s WHERE s.user_id = u.id)');
      expect(sql).toContain(
        'OR EXISTS (SELECT 1 FROM contracts c WHERE c.freelancer_id = u.id)) AS d',
      );
      expect(sql).toContain('FROM users u WHERE u.id = :userId');
      expect(params).toEqual({ userId: 7 });
    });

    it('quem só contrata, ou uma conta que não existe, não entrega trabalho', async () => {
      fakeDb.reply([{ d: 0 }], [], [{ d: null }]);

      expect(await pushRepository.deliversWork(7)).toBe(false);
      expect(await pushRepository.deliversWork(999)).toBe(false);
      expect(await pushRepository.deliversWork(8)).toBe(false);
    });
  });
});
