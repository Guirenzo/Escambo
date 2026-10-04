import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./settings.repository', () => ({
  settingsRepository: { list: vi.fn(), set: vi.fn(), get: vi.fn(), getNumber: vi.fn() },
}));

import { settingsRepository } from './settings.repository';
import { SETTING_KEYS } from './settings.schema';
import { settingsService, validateSettingValue } from './settings.service';

const repo = vi.mocked(settingsRepository);

beforeEach(() => {
  vi.clearAllMocks();
  settingsService.clearCache();
  repo.list.mockResolvedValue([]);
  repo.set.mockResolvedValue(undefined);
  repo.get.mockResolvedValue(null);
});

describe('settingsService (ADR 32/33)', () => {
  it('lista as chaves editáveis com tipo e padrão quando o banco não tem a linha', async () => {
    const items = await settingsService.listForAdmin();
    expect(items.map((i) => i.key)).toEqual([...SETTING_KEYS]);
    expect(items.find((i) => i.key === 'platform_fee_percentage')).toMatchObject({
      type: 'integer',
      value: 15,
      min: 0,
      max: 50,
      unit: '%',
      updatedBy: null,
    });
    expect(items.find((i) => i.key === 'maintenance_mode')).toMatchObject({
      type: 'boolean',
      value: false,
      defaultValue: false,
    });
    expect(items.find((i) => i.key === 'min_withdrawal_amount')).toMatchObject({
      type: 'decimal',
      value: 20,
      unit: 'R$',
    });
  });

  it('usa o valor do banco por tipo (bool "true"/"1", número) com autor e data; lixo vira padrão', async () => {
    repo.list.mockResolvedValue([
      {
        key_name: 'tacit_approval_days',
        value: '3',
        type: 'integer',
        updated_at: new Date('2026-09-14T12:00:00Z'),
        updated_by_email: 'admin@escambo.demo',
      },
      {
        key_name: 'deadline_grace_hours',
        value: 'abc',
        type: 'integer',
        updated_at: null,
        updated_by_email: null,
      },
      {
        key_name: 'barter_enabled',
        value: 'false',
        type: 'boolean',
        updated_at: null,
        updated_by_email: null,
      },
      {
        key_name: 'maintenance_mode',
        value: '1',
        type: 'boolean',
        updated_at: null,
        updated_by_email: null,
      },
      {
        key_name: 'min_service_price',
        value: '12.50',
        type: 'decimal',
        updated_at: null,
        updated_by_email: null,
      },
    ] as never);
    const items = await settingsService.listForAdmin();
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by.tacit_approval_days).toMatchObject({
      value: 3,
      updatedAt: '2026-09-14T12:00:00.000Z',
      updatedBy: 'admin@escambo.demo',
    });
    expect(by.deadline_grace_hours!.value).toBe(24);
    expect(by.barter_enabled!.value).toBe(false);
    expect(by.maintenance_mode!.value).toBe(true);
    expect(by.min_service_price!.value).toBe(12.5);
  });

  it('número em branco no banco é chave sem valor: vale o padrão, e não zero (a mesma leitura do getNumber dos jobs)', async () => {
    const blank = (key_name: string, value: string) => ({
      key_name,
      value,
      type: 'integer',
      updated_at: null,
      updated_by_email: null,
    });
    repo.list.mockResolvedValue([
      blank('deadline_grace_hours', ''),
      blank('platform_fee_percentage', '   '),
      blank('tacit_approval_days', '\n\t'),
      blank('proposal_expiry_hours', ' 48 '),
    ] as never);

    const by = Object.fromEntries((await settingsService.listForAdmin()).map((i) => [i.key, i]));
    expect(by.deadline_grace_hours!.value).toBe(24);
    expect(by.platform_fee_percentage!.value).toBe(15);
    expect(by.tacit_approval_days!.value).toBe(5);
    // Número com espaços em volta continua valendo.
    expect(by.proposal_expiry_hours!.value).toBe(48);

    // A leitura com cache (a da tela da contratação e dos parâmetros públicos) também.
    repo.get.mockResolvedValue('');
    expect(await settingsService.number('deadline_grace_hours')).toBe(24);
    expect(await settingsService.feeRate()).toBe(0.15);
    expect((await settingsService.publicSettings()).deadlineGraceHours).toBe(24);
  });

  it('validateSettingValue: inteiro, decimal (2 casas) e liga/desliga, cada um nos seus limites', () => {
    expect(validateSettingValue('platform_fee_percentage', 10)).toBe('10');
    expect(() => validateSettingValue('platform_fee_percentage', 51)).toThrow(/entre 0 e 50/);
    expect(() => validateSettingValue('tacit_approval_days', 2.5)).toThrow(/inteiro/);
    expect(() => validateSettingValue('tacit_approval_days', true)).toThrow(/inteiro/);
    expect(validateSettingValue('min_withdrawal_amount', 25.5)).toBe('25.5');
    expect(() => validateSettingValue('min_withdrawal_amount', 25.555)).toThrow(/2 casas/);
    expect(() => validateSettingValue('min_withdrawal_amount', 0.5)).toThrow(/entre 1 e 10000/);
    expect(validateSettingValue('maintenance_mode', true)).toBe('true');
    expect(validateSettingValue('barter_enabled', false)).toBe('false');
    expect(() => validateSettingValue('maintenance_mode', 1)).toThrow(/ligado ou desligado/);
  });

  it('update grava a string do tipo com o autor e limpa o cache da chave', async () => {
    repo.get.mockResolvedValue('false');
    expect(await settingsService.maintenanceMode()).toBe(false);
    repo.get.mockResolvedValue('true');
    expect(await settingsService.maintenanceMode()).toBe(false); // cache de 5 s
    repo.list.mockResolvedValue([
      {
        key_name: 'maintenance_mode',
        value: 'true',
        type: 'boolean',
        updated_at: null,
        updated_by_email: null,
      },
    ] as never);
    const item = await settingsService.update('maintenance_mode', true, 9);
    expect(repo.set).toHaveBeenCalledWith('maintenance_mode', 'true', 'boolean', 9);
    expect(item.value).toBe(true);
    expect(await settingsService.maintenanceMode()).toBe(true); // cache limpo
  });

  it('a lista do painel pede ao banco todas as chaves editáveis, de uma vez', async () => {
    await settingsService.listForAdmin();
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(repo.list).toHaveBeenCalledWith([...SETTING_KEYS]);
  });

  it('update com valor fora dos limites é 422 value_out_of_range e nada é gravado', async () => {
    await expect(settingsService.update('platform_fee_percentage', 51, 9)).rejects.toMatchObject({
      statusCode: 422,
      code: 'value_out_of_range',
    });
    await expect(settingsService.update('maintenance_mode', 1, 9)).rejects.toMatchObject({
      statusCode: 422,
      code: 'value_out_of_range',
    });
    expect(repo.set).not.toHaveBeenCalled();
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('os limites da chave são inclusivos: o mínimo e o máximo passam, um a mais ou a menos não', () => {
    expect(validateSettingValue('platform_fee_percentage', 0)).toBe('0');
    expect(validateSettingValue('platform_fee_percentage', 50)).toBe('50');
    expect(() => validateSettingValue('platform_fee_percentage', -1)).toThrow(/entre 0 e 50 %/);
    expect(validateSettingValue('min_withdrawal_amount', 1)).toBe('1');
    expect(validateSettingValue('min_withdrawal_amount', 10000)).toBe('10000');
    expect(() => validateSettingValue('min_withdrawal_amount', 10000.01)).toThrow(
      /entre 1 e 10000 R\$/,
    );
    expect(() => validateSettingValue('tacit_approval_days', Number.NaN)).toThrow(/inteiro/);
    expect(() => validateSettingValue('tacit_approval_days', Infinity)).toThrow(/inteiro/);
  });

  it('update grava número como texto, com o tipo da chave e o admin, e devolve a linha relida daquela chave', async () => {
    repo.list.mockResolvedValue([
      {
        key_name: 'min_service_price',
        value: '12.5',
        type: 'decimal',
        updated_at: new Date('2026-09-14T12:00:00Z'),
        updated_by_email: 'admin@escambo.demo',
      },
    ] as never);

    const item = await settingsService.update('min_service_price', 12.5, 9);

    expect(repo.set).toHaveBeenCalledTimes(1);
    expect(repo.set).toHaveBeenCalledWith('min_service_price', '12.5', 'decimal', 9);
    expect(repo.list).toHaveBeenCalledWith(['min_service_price']);
    expect(item).toMatchObject({
      key: 'min_service_price',
      type: 'decimal',
      value: 12.5,
      defaultValue: 10,
      min: 1,
      max: 100000,
      unit: 'R$',
      updatedAt: '2026-09-14T12:00:00.000Z',
      updatedBy: 'admin@escambo.demo',
    });
    // Grava antes de reler: o que volta é o que ficou no banco.
    expect(repo.set.mock.invocationCallOrder[0]!).toBeLessThan(
      repo.list.mock.invocationCallOrder[0]!,
    );
  });

  describe('cache curto das leituras', () => {
    afterEach(() => vi.useRealTimers());

    it('dentro de 5 s a chave não volta ao banco; passado esse tempo, a leitura é refeita', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-15T12:00:00Z') });
      repo.get.mockResolvedValue('true');
      expect(await settingsService.maintenanceMode()).toBe(true);

      repo.get.mockResolvedValue('false');
      vi.setSystemTime(new Date('2026-09-15T12:00:04.999Z'));
      expect(await settingsService.maintenanceMode()).toBe(true);
      expect(repo.get).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-09-15T12:00:05Z'));
      expect(await settingsService.maintenanceMode()).toBe(false);
      expect(repo.get).toHaveBeenCalledTimes(2);
      expect(repo.get).toHaveBeenLastCalledWith('maintenance_mode');
    });

    it('o cache é por chave: ler uma não serve de resposta para outra, e a ausência da chave também fica em cache', async () => {
      repo.get.mockResolvedValueOnce('false').mockResolvedValueOnce(null);

      expect(await settingsService.barterEnabled()).toBe(false);
      expect(await settingsService.maintenanceMode()).toBe(false);
      expect(await settingsService.maintenanceMode()).toBe(false);

      expect(repo.get).toHaveBeenCalledTimes(2);
      expect(repo.get).toHaveBeenNthCalledWith(1, 'barter_enabled');
      expect(repo.get).toHaveBeenNthCalledWith(2, 'maintenance_mode');
    });

    it('update só limpa o cache da chave alterada', async () => {
      repo.get.mockResolvedValue('false');
      expect(await settingsService.barterEnabled()).toBe(false);
      expect(await settingsService.maintenanceMode()).toBe(false);

      repo.get.mockResolvedValue('true');
      await settingsService.update('maintenance_mode', true, 9);

      expect(await settingsService.maintenanceMode()).toBe(true);
      // Trocas continuam com o valor em cache: ninguém mexeu nelas.
      expect(await settingsService.barterEnabled()).toBe(false);
    });
  });

  it('cada leitor lê a sua chave, com o valor gravado no banco e não o padrão', async () => {
    const stored: Record<string, string> = {
      platform_fee_percentage: '12',
      tacit_approval_days: '3',
      proposal_expiry_hours: '48',
      deadline_grace_hours: '36',
      min_service_price: '25.50',
      min_withdrawal_amount: '50',
      barter_enabled: 'false',
      maintenance_mode: 'true',
    };
    repo.get.mockImplementation(async (key: string) => stored[key] ?? null);

    expect(await settingsService.feeRate()).toBe(0.12);
    expect(await settingsService.minServicePrice()).toBe(25.5);
    expect(await settingsService.minWithdrawal()).toBe(50);
    expect(await settingsService.barterEnabled()).toBe(false);
    expect(await settingsService.maintenanceMode()).toBe(true);
    expect(await settingsService.publicSettings()).toEqual({
      platformFeePercentage: 12,
      tacitApprovalDays: 3,
      proposalExpiryHours: 48,
      deadlineGraceHours: 36,
      extensionResponseHours: 48,
      minServicePrice: 25.5,
      minWithdrawalAmount: 50,
      barterEnabled: false,
      maintenanceMode: true,
    });
  });

  it('liga/desliga lido como número vira 1 ou 0, e número lido como liga/desliga é sempre desligado', async () => {
    repo.get.mockImplementation(async (key: string) =>
      key === 'maintenance_mode' ? 'true' : key === 'barter_enabled' ? 'false' : '7',
    );

    expect(await settingsService.number('maintenance_mode')).toBe(1);
    expect(await settingsService.number('barter_enabled')).toBe(0);
    expect(await settingsService.flag('strike_upload_block_days')).toBe(false);
    expect(await settingsService.value('strike_upload_block_days')).toBe(7);
  });

  it('leitores tipados e públicos com padrões quando não há linha', async () => {
    expect(await settingsService.feeRate()).toBe(0.15);
    expect(await settingsService.barterEnabled()).toBe(true);
    expect(await settingsService.minWithdrawal()).toBe(20);
    expect(await settingsService.minServicePrice()).toBe(10);
    expect(await settingsService.publicSettings()).toEqual({
      platformFeePercentage: 15,
      tacitApprovalDays: 5,
      proposalExpiryHours: 72,
      deadlineGraceHours: 24,
      extensionResponseHours: 48,
      minServicePrice: 10,
      minWithdrawalAmount: 20,
      barterEnabled: true,
      maintenanceMode: false,
    });
  });
});
