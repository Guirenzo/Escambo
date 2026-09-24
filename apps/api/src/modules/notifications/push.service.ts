import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { pushRepository } from './push.repository';
import {
  activePushProvider,
  vapidKeys,
  type PushPayload,
  type PushSendOptions,
} from './push.provider';
import { EMAILED_NOTIFICATION_TYPES } from '../mail/mail.service';
import { authRepository } from '../auth/auth.repository';
import { notificationsRepository } from './notifications.repository';
import { hourIn, timezoneOf } from '../../utils/timezone';
import { inQuietWindow, pushTtlSeconds, quietWindowOf } from './quiet-hours';

/**
 * Avisos push no navegador (ADR 52): a assinatura de cada aparelho é a preferência, e o envio
 * acompanha a notificação in-app. Nunca lança: push é o canal que pode falhar sem estragar nada.
 */

/** Tipos que valem uma batida no aparelho: os mesmos do e-mail (ADR 27), sem o ruído do dia a dia. */
export const PUSHED_NOTIFICATION_TYPES = EMAILED_NOTIFICATION_TYPES;

/** Para onde a notificação leva quando a pessoa toca no aviso. */
export function pushUrl(type: string, data: Record<string, unknown> | null | undefined): string {
  const contractId = data?.contractId;
  if (typeof contractId === 'number' || typeof contractId === 'string') {
    return `/contratos/${contractId}`;
  }
  if (type.startsWith('barter_')) return '/trocas';
  if (type.startsWith('withdrawal_') || type.startsWith('deposit_')) return '/carteira';
  if (type === 'saved_search_match') return '/servicos';
  return '/notificacoes';
}

/** Corte no corpo do aviso: o sistema já corta, e cortar aqui deixa o texto previsível. */
export const trimBody = (body: string | null | undefined, max = 120): string => {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};

/** O assunto do aviso: dois avisos do mesmo assunto se substituem no aparelho. */
const TARGET_KEYS = [
  'contractId',
  'disputeId',
  'barterId',
  'savedSearchId',
  'withdrawalId',
  'paymentId',
  'reviewId',
  'removalId',
] as const;

export function buildPayload(params: {
  type: string;
  title: string;
  body?: string | null;
  data?: Record<string, unknown> | null;
  /** Id da notificação in-app: vira a etiqueta quando o aviso não tem assunto próprio. */
  notificationId?: number;
}): PushPayload {
  const target = TARGET_KEYS.map((key) => params.data?.[key]).find(
    (value) => typeof value === 'number' || typeof value === 'string',
  );
  // Sem assunto, cada aviso fica com etiqueta própria: um não apaga o outro no aparelho.
  const tag =
    target != null
      ? `${params.type}:${String(target)}`
      : `${params.type}:n${params.notificationId ?? 0}`;
  return {
    title: params.title,
    body: trimBody(params.body),
    url: pushUrl(params.type, params.data),
    tag,
  };
}

/**
 * O push único do fim do silêncio quando ficou mais de um aviso (ADR 54): título fixo, corpo com
 * os primeiros títulos, etiqueta fixa (um resumo substitui o anterior no aparelho).
 */
export function quietSummaryPayload(items: readonly { title: string }[]): PushPayload {
  const titles = items
    .slice(0, 3)
    .map((i) => i.title)
    .join(' · ');
  return {
    title: 'Enquanto você estava em silêncio',
    body: trimBody(`${items.length} avisos ficaram por ver: ${titles}`),
    url: '/notificacoes',
    tag: 'quiet_summary',
  };
}

export const pushService = {
  /**
   * Chave pública para o navegador assinar; muda se o processo subir sem chaves fixas. Com o canal
   * desligado não há chave: a tela usa isso para explicar em vez de oferecer um botão sem efeito.
   */
  publicKey(): string {
    return env.PUSH_PROVIDER === 'off' ? '' : vapidKeys().publicKey;
  },

  async subscribe(
    userId: number,
    sub: { endpoint: string; p256dh: string; auth: string },
  ): Promise<void> {
    await pushRepository.upsert({ userId, ...sub });
  },

  async unsubscribe(userId: number, endpoint: string): Promise<boolean> {
    return pushRepository.remove(userId, endpoint);
  },

  /** Este aparelho recebe avisos desta conta? (o navegador pode ter assinatura de outra) */
  subscribed(userId: number, endpoint: string): Promise<boolean> {
    return pushRepository.belongsTo(userId, endpoint);
  },

  /** Quantos aparelhos desta conta recebem push agora. */
  devices(userId: number): Promise<number> {
    return pushRepository.countForUser(userId);
  },

  /**
   * Envia para todos os aparelhos da conta. Assinatura que o serviço de push recusa por não
   * existir mais é apagada na hora, então a lista não acumula aparelho morto.
   */
  async send(
    userId: number,
    payload: PushPayload,
    opts: PushSendOptions = {},
  ): Promise<{ sent: number; removed: number; failed: number }> {
    if (env.PUSH_PROVIDER === 'off') return { sent: 0, removed: 0, failed: 0 };
    const provider = activePushProvider();
    const subs = await pushRepository.listForUser(userId);
    let sent = 0;
    let removed = 0;
    let failed = 0;
    for (const sub of subs) {
      const result = await provider.send(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth_key },
        payload,
        opts,
      );
      if (result === 'sent') {
        sent += 1;
        await pushRepository.markSent(sub.id);
      } else if (result === 'gone') {
        removed += 1;
        await pushRepository.removeById(sub.id);
      } else {
        failed += 1;
        await pushRepository.markError(sub.id, `provedor ${provider.name}`);
      }
    }
    return { sent, removed, failed };
  },

  /** Acompanha a notificação in-app (best-effort): só os tipos que valem uma batida. */
  async notify(
    userId: number,
    params: {
      type: string;
      title: string;
      body?: string | null;
      data?: Record<string, unknown> | null;
      notificationId?: number;
    },
    now: Date = new Date(),
  ): Promise<void> {
    if (env.PUSH_PROVIDER === 'off') return;
    try {
      if (!PUSHED_NOTIFICATION_TYPES.has(params.type)) return;
      // Conta encerrada não recebe aviso nenhum, como já vale para o e-mail.
      const user = await authRepository.findById(userId);
      if (!user || user.deleted_at) return;
      const zone = timezoneOf(user.timezone);
      const window = quietWindowOf(user.push_quiet_start, user.push_quiet_end);
      // "Não perturbe" (ADR 54): dentro da janela o push não sai. A notificação fica marcada
      // como retida e o resumo ao fim da janela cobre; in-app, socket e e-mail já saíram.
      // Uma decisão só, no instante do evento: 21:59:59 sai, 22:00:00 fica.
      if (inQuietWindow(hourIn(zone, now), window)) {
        if (params.notificationId) {
          await notificationsRepository.markPushHeld(params.notificationId, now);
        }
        logger.debug({ userId, type: params.type }, 'push retido pela janela de silêncio');
        return;
      }
      await this.send(userId, buildPayload(params), {
        ttlSeconds: pushTtlSeconds(zone, window, now),
      });
    } catch (err) {
      logger.warn({ err, type: params.type }, 'push da notificação falhou');
    }
  },

  /**
   * Aviso de teste: fura o silêncio de propósito (é a pessoa apertando um botão olhando a tela),
   * mas não fura o de um aparelho offline horas depois — o TTL acaba no próximo início.
   */
  async sendTest(
    userId: number,
    now: Date = new Date(),
  ): Promise<{ sent: number; removed: number; failed: number }> {
    const user = await authRepository.findById(userId);
    const zone = timezoneOf(user?.timezone);
    const window = quietWindowOf(user?.push_quiet_start, user?.push_quiet_end);
    return this.send(
      userId,
      buildPayload({
        type: 'push_test',
        title: 'Tudo certo!',
        body: 'É assim que os avisos do Escambo vão chegar neste aparelho.',
      }),
      { ttlSeconds: pushTtlSeconds(zone, window, now) },
    );
  },

  /** Avisos retidos pelo silêncio, ainda por ver, que o resumo vai cobrir (ADR 54). */
  held(userId: number): Promise<number> {
    return notificationsRepository.countHeld(userId);
  },
};
