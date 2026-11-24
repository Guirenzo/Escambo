/**
 * Service dos parâmetros da plataforma (camada de service). Os parâmetros são os valores que o
 * admin muda pelo painel sem deploy (taxa, prazos, mínimos, trocas, manutenção), guardados na
 * tabela `platform_settings`, uma linha por chave, com o valor sempre em texto.
 * Pra que serve: ler cada chave já no tipo certo (número ou liga/desliga, com o padrão quando
 * falta), validar e gravar a mudança do admin, e montar o pacote público que o app lê sem login.
 * Quem chama: o settings.controller (público), o admin.controller (listar e mudar), o middleware de
 * manutenção e os services que precisam de um valor (contratos e trocas pela taxa, saque etc.).
 * O que chama: o settingsRepository (SQL), o settings.schema (limites) e o settings.parse.
 * Dentro: o cache curto de 5 s, rawValue, parseValue, toItem, validateSettingValue e o objeto
 * settingsService (listForAdmin, update, value/number/flag, atalhos por chave e publicSettings).
 */
import type { PlatformSetting, PublicSettings, WithdrawalMethod } from '@escambo/types';
import { env } from '../../config/env';
import { HttpError } from '../../utils/http-error';
import { INCLUDED_REVISIONS } from '../contracts/deadline-grace';
import { DISPUTE_TACIT_MARGIN_MS, DISPUTE_WAIT_MS } from '../contracts/dispute-window';
import { MAX_OFFERS } from '../contracts/offers';
import { DROPOUT_AGREE_DAYS, DROPOUT_ALERT_AT, DROPOUT_WINDOW_DAYS } from '../dropouts/dropouts';
import { parseNumberSetting } from './settings.parse';
import { settingsRepository } from './settings.repository';
import { SETTING_DEFS, SETTING_KEYS, type SettingKey } from './settings.schema';

/**
 * Cache curto das chaves lidas em caminhos quentes (modo manutenção é consultado a cada
 * requisição). Um update limpa o cache no processo; em cluster, as outras instâncias veem a
 * mudança em até CACHE_TTL_MS.
 */
const CACHE_TTL_MS = 5_000;
// O cache é um Map na memória do processo: chave do parâmetro para o valor cru e o instante em
// que foi lido. Mudança feita direto por SQL aparece em até 5 s.
const cache = new Map<string, { value: string | null; at: number }>();
// Cache à parte para a hora prevista da volta da manutenção, que é calculada e não lida pronta.
let returnAtCache: { value: Date | null; at: number } | null = null;

/**
 * Valor cru (texto) de uma chave, ou null se ela não existe no banco. Usa o cache: se a leitura
 * guardada tem menos de 5 s, devolve sem ir ao banco; senão lê, guarda com o instante e devolve.
 * O `now` é parâmetro para os testes poderem controlar o relógio.
 */
async function rawValue(key: SettingKey, now = Date.now()): Promise<string | null> {
  const hit = cache.get(key);
  // Acerto no cache e ainda dentro dos 5 s: não consulta o MySQL.
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await settingsRepository.get(key);
  cache.set(key, { value, at: now });
  return value;
}

/**
 * Converte o texto do banco no tipo da chave. Liga/desliga: 'true' ou '1' é ligado, e a chave
 * ausente fica com o padrão. Número: passa pelo parseNumberSetting, o mesmo dos jobs.
 */
function parseValue(key: SettingKey, raw: string | null | undefined): number | boolean {
  const def = SETTING_DEFS[key];
  if (def.type === 'boolean') return raw == null ? def.defaultValue : raw === 'true' || raw === '1';
  // A mesma regra do settingsRepository.getNumber (valor em branco é o padrão, e não zero): os
  // jobs leem a chave por lá, e a tela não pode mostrar outro prazo.
  return parseNumberSetting(raw, def.defaultValue as number, key);
}

/**
 * Monta o item que o painel do admin mostra: a definição da chave (rótulo, descrição, unidade,
 * limites, padrão) junto com o valor atual do banco, a data da última mudança e o e-mail de quem
 * mudou. Sem linha no banco, o valor é o padrão e a data e o autor ficam nulos.
 */
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
// Exemplo: a taxa (inteira, de 0 a 50) recusa 12.5 e 60 com 422 `value_out_of_range`, e aceita
// 12, que vai para o banco como o texto '12'.
export function validateSettingValue(key: SettingKey, value: number | boolean): string {
  const def = SETTING_DEFS[key];
  // Liga/desliga só aceita true ou false, e grava como o texto 'true' ou 'false'.
  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new HttpError(422, `${def.label}: informe ligado ou desligado`, 'value_out_of_range');
    }
    return value ? 'true' : 'false';
  }
  // Número: tem que ser finito, ficar entre o min e o max da chave e, conforme o tipo, ser
  // inteiro ou ter no máximo 2 casas decimais (arredondar em centavos não pode mudar o valor).
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= def.min &&
    value <= def.max &&
    (def.type === 'integer' ? Number.isInteger(value) : Math.round(value * 100) / 100 === value);
  // Fora da regra: 422 com uma mensagem que já diz a faixa aceita, para o painel mostrar.
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
    // Uma consulta só para todas as chaves; o Map acha a linha de cada chave sem varrer a lista.
    // A ordem da resposta é a da SETTING_KEYS, e chave sem linha no banco aparece com o padrão.
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
    // 1. Confere tipo e limites; recusa com 422 antes de tocar no banco.
    const stored = validateSettingValue(key, value);
    // 2. Grava o valor com o tipo e o id do admin (a coluna updated_by mostra quem mudou).
    await settingsRepository.set(key, stored, SETTING_DEFS[key].type, adminId);
    // 3. Esquece o que estava no cache, para a próxima leitura neste processo já pegar o novo.
    cache.delete(key);
    returnAtCache = null;
    // 4. Relê a linha para devolver ao painel o item atualizado, com data e autor.
    // A auditoria (valor antigo e novo) é registrada pelo admin.controller, que chama esta função.
    const rows = await settingsRepository.list([key]);
    return toItem(key, rows[0]);
  },

  /** Valor tipado de uma chave, com cache curto e fallback ao padrão. */
  async value(key: SettingKey): Promise<number | boolean> {
    return parseValue(key, await rawValue(key));
  },
  // number e flag são atalhos tipados do value: um para chave numérica, outro para liga/desliga.
  async number(key: SettingKey): Promise<number> {
    const v = await this.value(key);
    return typeof v === 'number' ? v : Number(v);
  },
  async flag(key: SettingKey): Promise<boolean> {
    return (await this.value(key)) === true;
  },

  /** Comissão como fração (0.15), lida na hora — contratações e trocas gravam a que valia. */
  // O banco guarda a porcentagem (15); a conta da taxa usa a fração (0.15), daí a divisão por 100.
  // Quem chama: contracts.service (na criação da contratação) e barter.service (torna da troca).
  async feeRate(): Promise<number> {
    return (await this.number('platform_fee_percentage')) / 100;
  },
  // Atalhos por chave: cada um lê um parâmetro já no tipo certo, para quem chama não repetir nome.
  maintenanceMode(): Promise<boolean> {
    return this.flag('maintenance_mode');
  },
  /**
   * Hora prevista da volta (RNF-010): os minutos da previsão contados da última mudança do modo ou
   * da própria previsão. Nula com o modo desligado ou sem previsão (0). Cacheada como as chaves,
   * porque o 503 de manutenção a consulta a cada requisição.
   */
  async maintenanceReturnAt(now = Date.now()): Promise<Date | null> {
    if (returnAtCache && now - returnAtCache.at < CACHE_TTL_MS) return returnAtCache.value;
    let value: Date | null = null;
    // Lê as duas chaves ao mesmo tempo (Promise.all): o modo está ligado e quantos minutos faltam.
    const [on, minutes] = await Promise.all([
      this.flag('maintenance_mode'),
      this.number('maintenance_return_minutes'),
    ]);
    // Com previsão: o ponto de partida é a mudança mais recente das duas chaves (updated_at), e a
    // volta é esse instante mais os minutos.
    if (on && minutes > 0) {
      const rows = await settingsRepository.list([
        'maintenance_mode',
        'maintenance_return_minutes',
      ]);
      const since = Math.max(
        0,
        ...rows.map((r) => (r.updated_at ? new Date(r.updated_at).getTime() : 0)),
      );
      if (since > 0) value = new Date(since + minutes * 60_000);
    }
    returnAtCache = { value, at: now };
    return value;
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
  /** Prazo do saque em dias úteis, pela forma de recebimento (RN-035), lido na hora do pedido. */
  withdrawalBusinessDays(method: WithdrawalMethod): Promise<number> {
    return this.number(
      method === 'pix' ? 'withdrawal_pix_business_days' : 'withdrawal_bank_business_days',
    );
  },

  /** O que o app precisa saber sem ser admin (taxa, prazos, mínimos, manutenção, trocas). */
  // Lê as chaves em paralelo (cada uma passa pelo cache) e junta com as regras fixas do código
  // (fixedContractRules), que não são parâmetro do painel. Nada aqui é segredo: é o que a tela
  // mostra ao usuário. Quem chama: GET /api/settings/public.
  async publicSettings(): Promise<PublicSettings> {
    const [
      fee,
      tacit,
      expiry,
      counterResponse,
      extensionResponse,
      grace,
      minService,
      minWithdrawal,
      pixDays,
      bankDays,
      barter,
      maintenance,
    ] = await Promise.all([
      this.number('platform_fee_percentage'),
      this.number('tacit_approval_days'),
      this.number('proposal_expiry_hours'),
      this.number('counter_offer_response_hours'),
      this.number('extension_response_hours'),
      this.number('deadline_grace_hours'),
      this.number('min_service_price'),
      this.number('min_withdrawal_amount'),
      this.withdrawalBusinessDays('pix'),
      this.withdrawalBusinessDays('bank'),
      this.flag('barter_enabled'),
      this.flag('maintenance_mode'),
    ]);
    const returnAt = maintenance ? await this.maintenanceReturnAt() : null;
    return {
      platformFeePercentage: fee,
      tacitApprovalDays: tacit,
      proposalExpiryHours: expiry,
      counterOfferResponseHours: counterResponse,
      deadlineGraceHours: grace,
      extensionResponseHours: extensionResponse,
      fixedContractRules: {
        includedRevisions: INCLUDED_REVISIONS,
        maxOffers: MAX_OFFERS,
        disputeWaitHours: DISPUTE_WAIT_MS / 3_600_000,
        disputeTacitMarginHours: DISPUTE_TACIT_MARGIN_MS / 3_600_000,
        dropoutWindowDays: DROPOUT_WINDOW_DAYS,
        dropoutAlertAt: DROPOUT_ALERT_AT,
        dropoutAgreementDays: DROPOUT_AGREE_DAYS,
      },
      minServicePrice: minService,
      minWithdrawalAmount: minWithdrawal,
      withdrawalBusinessDays: { pix: pixDays, bank: bankDays },
      barterEnabled: barter,
      maintenanceMode: maintenance,
      maintenanceReturnAt: returnAt?.toISOString() ?? null,
      paymentGateway: env.PAYMENT_GATEWAY,
      paymentSandbox: env.PAYMENT_GATEWAY === 'mercadopago' && env.MERCADOPAGO_SANDBOX,
    };
  },

  /** Só para testes: esquece o cache. */
  clearCache(): void {
    cache.clear();
    returnAtCache = null;
  },
};
