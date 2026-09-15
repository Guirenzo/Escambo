import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./settings.repository', () => ({
  settingsRepository: { list: vi.fn(), set: vi.fn(), getNumber: vi.fn() },
}));

import { settingsRepository } from './settings.repository';
import { SETTING_DEFS, SETTING_KEYS } from './settings.schema';
import { settingsService } from './settings.service';

const repo = vi.mocked(settingsRepository);

beforeEach(() => {
  vi.clearAllMocks();
  repo.list.mockResolvedValue([]);
  repo.set.mockResolvedValue(undefined);
});

describe('settingsService (ADR 32)', () => {
  it('lista as chaves editáveis com o padrão quando o banco não tem a linha', async () => {
    const items = await settingsService.listForAdmin();
    expect(items.map((i) => i.key)).toEqual([...SETTING_KEYS]);
    const fee = items.find((i) => i.key === 'platform_fee_percentage')!;
    expect(fee).toMatchObject({
      value: 15,
      defaultValue: 15,
      min: 0,
      max: 50,
      unit: '%',
      updatedBy: null,
    });
  });

  it('usa o valor do banco, com autor e data, e ignora lixo não numérico', async () => {
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
    ] as never);
    const items = await settingsService.listForAdmin();
    expect(items.find((i) => i.key === 'tacit_approval_days')).toMatchObject({
      value: 3,
      updatedAt: '2026-09-14T12:00:00.000Z',
      updatedBy: 'admin@escambo.demo',
    });
    expect(items.find((i) => i.key === 'deadline_grace_hours')!.value).toBe(24);
  });

  it('update valida inteiro dentro dos limites da chave e grava com o autor', async () => {
    await expect(settingsService.update('platform_fee_percentage', 51, 9)).rejects.toMatchObject({
      statusCode: 422,
      code: 'value_out_of_range',
    });
    await expect(settingsService.update('attachment_retention_days', 6, 9)).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(settingsService.update('tacit_approval_days', 2.5, 9)).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(repo.set).not.toHaveBeenCalled();

    repo.list.mockResolvedValue([
      {
        key_name: 'platform_fee_percentage',
        value: '10',
        type: 'integer',
        updated_at: null,
        updated_by_email: null,
      },
    ] as never);
    const item = await settingsService.update('platform_fee_percentage', 10, 9);
    expect(repo.set).toHaveBeenCalledWith('platform_fee_percentage', '10', 'integer', 9);
    expect(item.value).toBe(10);
  });

  it('feeRate e publicSettings leem na hora (padrões quando não há linha)', async () => {
    repo.getNumber.mockImplementation(async (_k, fallback) => fallback);
    expect(await settingsService.feeRate()).toBe(
      SETTING_DEFS.platform_fee_percentage.defaultValue / 100,
    );
    expect(await settingsService.publicSettings()).toEqual({
      platformFeePercentage: 15,
      tacitApprovalDays: 5,
      proposalExpiryHours: 72,
    });
    repo.getNumber.mockResolvedValue(8);
    expect(await settingsService.feeRate()).toBe(0.08);
  });
});
