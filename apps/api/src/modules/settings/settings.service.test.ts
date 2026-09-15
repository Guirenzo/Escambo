import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('leitores tipados e públicos com padrões quando não há linha', async () => {
    expect(await settingsService.feeRate()).toBe(0.15);
    expect(await settingsService.barterEnabled()).toBe(true);
    expect(await settingsService.minWithdrawal()).toBe(20);
    expect(await settingsService.minServicePrice()).toBe(10);
    expect(await settingsService.publicSettings()).toEqual({
      platformFeePercentage: 15,
      tacitApprovalDays: 5,
      proposalExpiryHours: 72,
      minServicePrice: 10,
      minWithdrawalAmount: 20,
      barterEnabled: true,
      maintenanceMode: false,
    });
  });
});
