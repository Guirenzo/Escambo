import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { settingsRepository } from './settings.repository';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

/**
 * Repository dos parâmetros da plataforma (platform_settings) sem banco: o que cada método pede
 * (chave no filtro, parâmetros) e o que faz com a resposta: o fallback da leitura, a trava dos
 * jobs (ADR 54 e 55) e a lista do painel admin. Se o SQL roda no MySQL é assunto da integração.
 */
describe('settingsRepository', () => {
  beforeEach(() => fakeDb.reset());

  describe('get', () => {
    it('lê o valor da chave como texto, e null quando a chave não existe', async () => {
      fakeDb.reply([{ value: 15 }], []);

      expect(await settingsRepository.get('platform_fee_percentage')).toBe('15');
      expect(await settingsRepository.get('nao_existe')).toBeNull();

      expect(fakeDb.calls[0]!.sql).toBe(
        'SELECT value FROM platform_settings WHERE key_name = :key LIMIT 1',
      );
      expect(fakeDb.calls[0]!.params).toEqual({ key: 'platform_fee_percentage' });
      expect(fakeDb.calls[1]!.params).toEqual({ key: 'nao_existe' });
    });

    it('null é só para chave que não existe: "false", zero e valor vazio voltam como o texto gravado', async () => {
      fakeDb.reply([{ value: 'false' }], [{ value: '0' }], [{ value: 0 }], [{ value: '' }]);
      expect(await settingsRepository.get('barter_enabled')).toBe('false');
      expect(await settingsRepository.get('strike_upload_block_days')).toBe('0');
      expect(await settingsRepository.get('strike_upload_block_days')).toBe('0');
      expect(await settingsRepository.get('job_state')).toBe('');
    });
  });

  describe('getNumber', () => {
    it('devolve o número gravado, inclusive zero e decimal', async () => {
      fakeDb.reply([{ value: '48' }], [{ value: '0' }], [{ value: '12.50' }]);

      expect(await settingsRepository.getNumber('deadline_grace_hours', 24)).toBe(48);
      expect(await settingsRepository.getNumber('strike_upload_block_days', 7)).toBe(0);
      expect(await settingsRepository.getNumber('min_service_price', 10)).toBe(12.5);

      // A leitura é a mesma do get, pela chave pedida.
      expect(fakeDb.calls[0]!.sql).toContain('FROM platform_settings WHERE key_name = :key');
      expect(fakeDb.calls[0]!.params).toEqual({ key: 'deadline_grace_hours' });
    });

    it('chave ausente ou valor que não é número cai no padrão: a plataforma não para por falta de chave', async () => {
      fakeDb.reply([], [{ value: 'abc' }], [{ value: 'Infinity' }]);

      expect(await settingsRepository.getNumber('deadline_grace_hours', 24)).toBe(24);
      expect(await settingsRepository.getNumber('deadline_grace_hours', 24)).toBe(24);
      expect(await settingsRepository.getNumber('deadline_grace_hours', 24)).toBe(24);
    });

    it('valor em branco (vazio ou só espaços) é chave sem valor: cai no padrão, e não em zero', async () => {
      fakeDb.reply([{ value: '' }], [{ value: '   ' }], [{ value: '\n\t' }]);

      expect(await settingsRepository.getNumber('deadline_grace_hours', 24)).toBe(24);
      expect(await settingsRepository.getNumber('proposal_expiry_hours', 72)).toBe(72);
      expect(await settingsRepository.getNumber('tacit_approval_days', 7)).toBe(7);
    });

    it('número com espaços em volta continua valendo', async () => {
      fakeDb.reply([{ value: ' 48 ' }]);
      expect(await settingsRepository.getNumber('deadline_grace_hours', 24)).toBe(48);
    });
  });

  describe('set', () => {
    it('cria a chave ou regrava o valor e o autor de uma chave que já existe', async () => {
      fakeDb.reply({ affectedRows: 1 });

      expect(
        await settingsRepository.set('platform_fee_percentage', '12', 'integer', 9),
      ).toBeUndefined();

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'INSERT INTO platform_settings (key_name, value, type, updated_by) VALUES (:key, :value, :type, :updatedBy)',
      );
      // Regravar troca o valor e quem mudou; o tipo da chave fica como nasceu.
      expect(sql.split('ON DUPLICATE KEY UPDATE')[1]!.trim()).toBe(
        'value = :value, updated_by = :updatedBy',
      );
      expect(params).toEqual({
        key: 'platform_fee_percentage',
        value: '12',
        type: 'integer',
        updatedBy: 9,
      });
    });

    it('sem tipo nem autor (estado de job), grava como texto e sem autor', async () => {
      await settingsRepository.set('job_state', '2026-09-15');
      expect(fakeDb.calls[0]!.params).toEqual({
        key: 'job_state',
        value: '2026-09-15',
        type: 'string',
        updatedBy: null,
      });
    });
  });

  describe('setIf: a trava de jobs que podem rodar em duas instâncias (ADR 54 e 55)', () => {
    it('esperando que a chave não exista, é um INSERT puro, e quem insere ganhou', async () => {
      fakeDb.reply({ affectedRows: 1 });

      expect(await settingsRepository.setIf('job_lock', '{"day":"2026-09-15"}', null)).toBe(true);

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toBe(
        'INSERT INTO platform_settings (key_name, value, type) VALUES (:key, :value, :type)',
      );
      // ON DUPLICATE KEY UPDATE contaria 1 também para a linha que já existia (CLIENT_FOUND_ROWS),
      // e as duas instâncias achariam que ganharam.
      expect(sql).not.toContain('ON DUPLICATE KEY');
      expect(params).toEqual({ key: 'job_lock', value: '{"day":"2026-09-15"}', type: 'json' });
    });

    it('chave duplicada é a outra instância que chegou antes: devolve false, sem erro', async () => {
      fakeDb.reply(Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }));
      expect(await settingsRepository.setIf('job_lock', 'x', null, 'string')).toBe(false);
      expect(fakeDb.calls[0]!.params).toEqual({ key: 'job_lock', value: 'x', type: 'string' });
    });

    it('qualquer outra falha do banco não é engolida como "perdi a corrida"', async () => {
      const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      const noCode = new Error('falha sem código');
      fakeDb.reply(down, noCode);

      await expect(settingsRepository.setIf('job_lock', 'x', null)).rejects.toBe(down);
      await expect(settingsRepository.setIf('job_lock', 'x', null)).rejects.toBe(noCode);
    });

    it('esperando um valor, só grava se o atual ainda for o esperado, e diz se foi esta chamada que gravou', async () => {
      fakeDb.reply({ affectedRows: 1 }, { affectedRows: 0 });

      expect(await settingsRepository.setIf('job_lock', 'novo', 'antigo')).toBe(true);
      expect(await settingsRepository.setIf('job_lock', 'outro', 'antigo')).toBe(false);

      expect(fakeDb.calls).toHaveLength(2);
      expect(fakeDb.calls[0]!.sql).toBe(
        'UPDATE platform_settings SET value = :value WHERE key_name = :key AND value = :expected',
      );
      expect(fakeDb.calls[0]!.params).toEqual({
        key: 'job_lock',
        value: 'novo',
        expected: 'antigo',
      });
      expect(fakeDb.calls[1]!.params).toEqual({
        key: 'job_lock',
        value: 'outro',
        expected: 'antigo',
      });
    });

    it('a falha do UPDATE condicional sobe para quem chamou, mesmo sendo chave duplicada', async () => {
      const boom = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
      fakeDb.reply(boom);
      await expect(settingsRepository.setIf('job_lock', 'novo', 'antigo')).rejects.toBe(boom);
    });
  });

  describe('list (painel admin)', () => {
    it('traz as linhas das chaves pedidas com o e-mail de quem mudou por último', async () => {
      const rows = [
        { key_name: 'maintenance_mode', value: 'true', updated_by_email: 'admin@escambo.test' },
        { key_name: 'barter_enabled', value: 'false', updated_by_email: null },
      ];
      fakeDb.reply(rows);

      const keys = ['maintenance_mode', 'barter_enabled', 'min_service_price'];
      expect(await settingsRepository.list(keys)).toBe(rows);

      expect(fakeDb.calls).toHaveLength(1);
      const { sql, params } = fakeDb.calls[0]!;
      expect(sql).toContain(
        'SELECT s.key_name, s.value, s.type, s.updated_at, u.email AS updated_by_email',
      );
      // Chave que ninguém editou ainda (sem autor) também aparece: LEFT JOIN.
      expect(sql).toContain('FROM platform_settings s LEFT JOIN users u ON u.id = s.updated_by');
      // Um marcador por chave: os nomes vão como parâmetros, não colados na instrução.
      expect(sql).toMatch(/WHERE s\.key_name IN \(\?, \?, \?\)$/);
      expect(sql).not.toContain('maintenance_mode');
      expect(params).toEqual(keys);
    });

    it('uma chave só usa um marcador só', async () => {
      await settingsRepository.list(['maintenance_mode']);
      expect(fakeDb.calls[0]!.sql).toMatch(/WHERE s\.key_name IN \(\?\)$/);
      expect(fakeDb.calls[0]!.params).toEqual(['maintenance_mode']);
    });

    it('sem chave nenhuma devolve lista vazia sem ir ao banco (IN () seria erro de sintaxe)', async () => {
      expect(await settingsRepository.list([])).toEqual([]);
      expect(fakeDb.calls).toHaveLength(0);
    });
  });
});
