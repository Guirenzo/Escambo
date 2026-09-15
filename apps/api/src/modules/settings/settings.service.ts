import type { PlatformSetting, PublicSettings } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { settingsRepository } from './settings.repository';
import { SETTING_DEFS, SETTING_KEYS, type SettingKey } from './settings.schema';

/**
 * Cache curto das chaves lidas em caminhos quentes (modo manutenção é consultado a cada
 * requisição). Um update limpa o cache no processo; em cluster, as outras instâncias veem a
 * mudança em até CACHE_TTL_MS.
 */
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { value: string | null; at: number }>();

async function rawValue(key: SettingKey, now = Date.now()): Promise<string | null> {
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await settingsRepository.get(key);
  cache.set(key, { value, at: now });
  return value;
}

function parseValue(key: SettingKey, raw: string | null | undefined): number | boolean {
  const def = SETTING_DEFS[key];
  if (raw == null) return def.defaultValue;
  if (def.type === 'boolean') return raw === 'true' || raw === '1';
  const n = Number(raw);
  return Number.isFinite(n) ? n : def.defaultValue;
}

function toItem(
  key: SettingKey,
  row: { value: string; updated_at: Date | null; updated_by_email: string | null } | undefined,
): PlatformSetting {
  const def = SETTING_DEFS[key];
  return {
    key,
    type: def.type,
    label: def.label,
    description: def.description,
    unit: def.unit,
    min: def.min,
    max: def.max,
    defaultValue: def.defaultValue,
    value: parseValue(key, row?.value),
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row?.updated_by_email ?? null,
  };
}

/** Valida o valor contra o tipo e os limites da chave; devolve a string que vai para o banco. */
export function validateSettingValue(key: SettingKey, value: number | boolean): string {
  const def = SETTING_DEFS[key];
  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new HttpError(422, `${def.label}: informe ligado ou desligado`, 'value_out_of_range');
    }
    return value ? 'true' : 'false';
  }
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= def.min &&
    value <= def.max &&
    (def.type === 'integer' ? Number.isInteger(value) : Math.round(value * 100) / 100 === value);
  if (!ok) {
    const kind = def.type === 'integer' ? 'um inteiro' : 'um valor (até 2 casas)';
    throw new HttpError(
      422,
      `${def.label}: informe ${kind} entre ${def.min} e ${def.max} ${def.unit}`.trim(),
      'value_out_of_range',
    );
  }
  return String(value);
}

export const settingsService = {
  /** Os parâmetros editáveis, com valor atual (ou padrão), limites e quem mudou por último. */
  async listForAdmin(): Promise<PlatformSetting[]> {
    const rows = await settingsRepository.list([...SETTING_KEYS]);
    const byKey = new Map(rows.map((r) => [r.key_name, r]));
    return SETTING_KEYS.map((key) => toItem(key, byKey.get(key)));
  },

  /** Valida, grava com o autor e limpa o cache: efeito imediato para quem lê. */
  async update(
    key: SettingKey,
    value: number | boolean,
    adminId: number,
  ): Promise<PlatformSetting> {
    const stored = validateSettingValue(key, value);
    await settingsRepository.set(key, stored, SETTING_DEFS[key].type, adminId);
    cache.delete(key);
    const rows = await settingsRepository.list([key]);
    return toItem(key, rows[0]);
  },

  /** Valor tipado de uma chave, com cache curto e fallback ao padrão. */
  async value(key: SettingKey): Promise<number | boolean> {
    return parseValue(key, await rawValue(key));
  },
  async number(key: SettingKey): Promise<number> {
    const v = await this.value(key);
    return typeof v === 'number' ? v : Number(v);
  },
  async flag(key: SettingKey): Promise<boolean> {
    return (await this.value(key)) === true;
  },

  /** Comissão como fração (0.15), lida na hora — contratações e trocas gravam a que valia. */
  async feeRate(): Promise<number> {
    return (await this.number('platform_fee_percentage')) / 100;
  },
  maintenanceMode(): Promise<boolean> {
    return this.flag('maintenance_mode');
  },
  barterEnabled(): Promise<boolean> {
    return this.flag('barter_enabled');
  },
  minWithdrawal(): Promise<number> {
    return this.number('min_withdrawal_amount');
  },
  minServicePrice(): Promise<number> {
    return this.number('min_service_price');
  },

  /** O que o app precisa saber sem ser admin (taxa, prazos, mínimos, manutenção, trocas). */
  async publicSettings(): Promise<PublicSettings> {
    const [fee, tacit, expiry, minService, minWithdrawal, barter, maintenance] = await Promise.all([
      this.number('platform_fee_percentage'),
      this.number('tacit_approval_days'),
      this.number('proposal_expiry_hours'),
      this.number('min_service_price'),
      this.number('min_withdrawal_amount'),
      this.flag('barter_enabled'),
      this.flag('maintenance_mode'),
    ]);
    return {
      platformFeePercentage: fee,
      tacitApprovalDays: tacit,
      proposalExpiryHours: expiry,
      minServicePrice: minService,
      minWithdrawalAmount: minWithdrawal,
      barterEnabled: barter,
      maintenanceMode: maintenance,
    };
  },

  /** Só para testes: esquece o cache. */
  clearCache(): void {
    cache.clear();
  },
};
