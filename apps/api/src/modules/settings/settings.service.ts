import type { PlatformSetting, PublicSettings } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { settingsRepository } from './settings.repository';
import { SETTING_DEFS, SETTING_KEYS, type SettingKey } from './settings.schema';

function toItem(
  key: SettingKey,
  row: { value: string; updated_at: Date | null; updated_by_email: string | null } | undefined,
): PlatformSetting {
  const def = SETTING_DEFS[key];
  const n = row ? Number(row.value) : NaN;
  return {
    key,
    label: def.label,
    description: def.description,
    unit: def.unit,
    min: def.min,
    max: def.max,
    defaultValue: def.defaultValue,
    value: Number.isFinite(n) ? n : def.defaultValue,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row?.updated_by_email ?? null,
  };
}

export const settingsService = {
  /** Os parâmetros editáveis, com valor atual (ou padrão), limites e quem mudou por último. */
  async listForAdmin(): Promise<PlatformSetting[]> {
    const rows = await settingsRepository.list([...SETTING_KEYS]);
    const byKey = new Map(rows.map((r) => [r.key_name, r]));
    return SETTING_KEYS.map((key) => toItem(key, byKey.get(key)));
  },

  /** Valida contra os limites da chave e grava com o autor; efeito imediato para quem lê. */
  async update(key: SettingKey, value: number, adminId: number): Promise<PlatformSetting> {
    const def = SETTING_DEFS[key];
    if (!Number.isInteger(value) || value < def.min || value > def.max) {
      throw new HttpError(
        422,
        `${def.label}: informe um inteiro entre ${def.min} e ${def.max} ${def.unit}`,
        'value_out_of_range',
      );
    }
    await settingsRepository.set(key, String(value), 'integer', adminId);
    const rows = await settingsRepository.list([key]);
    return toItem(key, rows[0]);
  },

  /** O que o app precisa saber sem ser admin (taxa no modal de contratação, prazos nas telas). */
  async publicSettings(): Promise<PublicSettings> {
    const [fee, tacit, expiry] = await Promise.all([
      settingsRepository.getNumber('platform_fee_percentage', 15),
      settingsRepository.getNumber('tacit_approval_days', 5),
      settingsRepository.getNumber('proposal_expiry_hours', 72),
    ]);
    return { platformFeePercentage: fee, tacitApprovalDays: tacit, proposalExpiryHours: expiry };
  },

  /** Comissão como fração (0.15), lida na hora — contratações e trocas gravam a que valia. */
  async feeRate(): Promise<number> {
    const pct = await settingsRepository.getNumber(
      'platform_fee_percentage',
      SETTING_DEFS.platform_fee_percentage.defaultValue,
    );
    return pct / 100;
  },
};
