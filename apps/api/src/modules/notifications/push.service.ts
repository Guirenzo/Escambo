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
import { timezoneOf } from '../../utils/timezone';
import type { QuietPassCategory } from '@escambo/types';
import { pushTiming, pushTtlSeconds, quietPassOf, quietWindowOf } from './quiet-hours';

/**
 * Avisos push no navegador (ADR 52): a assinatura de cada aparelho é a preferência, e o envio
 * acompanha a notificação in-app. Nunca lança: push é o canal que pode falhar sem estragar nada.
 */

/** Tipos que valem uma batida no aparelho: os mesmos do e-mail (ADR 27), sem o ruído do dia a dia. */
export const PUSHED_NOTIFICATION_TYPES = EMAILED_NOTIFICATION_TYPES;

/**
 * Categoria com que cada tipo PODE sair durante o silêncio (ADR 56); null = nunca sai. Todos os
 * tipos que viram push, nem um a mais: tipo novo sem classificação quebra o teste. Quem emite
 * afirma a categoria depois de olhar papel e estado; aqui só se confere o par.
 * Critério para entrar (as três): o sistema age sozinho, sem volta, sobre dinheiro ou contrato de
 * quem recebe; quem recebe consegue evitar pelo celular, em minutos; e esperar o fim da janela
 * tira dele parte do tempo para agir.
 */
export const QUIET_PASS_BY_TYPE: Readonly<Record<string, QuietPassCategory | null>> = {
  contract_overdue: 'deadline',
  deadline_extension_declined: 'deadline',
  contract_revision: 'deadline',
  contract_proposal: null,
  contract_accepted: null,
  contract_rejected: null,
  contract_delivered: null,
  contract_completed: null,
  contract_cancelled: null,
  contract_expired: null,
  deadline_extension_requested: null,
  deadline_extension_accepted: null,
  milestone_delivered: null,
  milestone_approved: null,
  milestone_revision: null,
  milestone_overdue: null,
  saved_search_match: null,
  dispute_opened: null,
  dispute_resolved: null,
  barter_proposed: null,
  barter_accepted: null,
  barter_completed: null,
  barter_disputed: null,
  deposit_confirmed: null,
  withdrawal_completed: null,
  withdrawal_failed: null,
  export_ready: null,
  deletion_rejected: null,
  review_received: null,
  content_removed: null,
  appeal_decided: null,
};

/** A categoria afirmada vale para este tipo? Qualquer outra coisa (inclusive chaves do protótipo) não. */
export function passCategoryFor(
  type: string,
  claimed: QuietPassCategory | null | undefined,
): QuietPassCategory | null {
  return claimed != null &&
    Object.hasOwn(QUIET_PASS_BY_TYPE, type) &&
    QUIET_PASS_BY_TYPE[type] === claimed
    ? claimed
    : null;
}

/** Tipo que anuncia prazo: vem primeiro no resumo do fim do silêncio (ADR 56). */
const announcesDeadline = (type: string | undefined): boolean =>
  type != null && Object.hasOwn(QUIET_PASS_BY_TYPE, type) && QUIET_PASS_BY_TYPE[type] !== null;

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

export function buildPayload(
  params: {
    type: string;
    title: string;
    body?: string | null;
    data?: Record<string, unknown> | null;
    /** Id da notificação in-app: vira a etiqueta quando o aviso não tem assunto próprio. */
    notificationId?: number;
  },
  opts: { ownTag?: boolean } = {},
): PushPayload {
  const target = TARGET_KEYS.map((key) => params.data?.[key]).find(
    (value) => typeof value === 'number' || typeof value === 'string',
  );
  // Sem assunto, cada aviso fica com etiqueta própria: um não apaga o outro no aparelho. O que sai
  // durante o silêncio (ADR 56) também: o mesmo tipo se repete na mesma contratação (nova recusa,
  // nova revisão), e trocar um aviso de mesma etiqueta não alerta de novo no Chrome nem no Firefox
  // (renotify só o Chrome respeita, e exigiria um service worker novo).
  const subject = target != null ? `${params.type}:${String(target)}` : null;
  const own = `n${params.notificationId ?? 0}`;
  const tag =
    subject === null ? `${params.type}:${own}` : opts.ownTag ? `${subject}:${own}` : subject;
  return {
    title: params.title,
    body: trimBody(params.body),
    url: pushUrl(params.type, params.data),
    tag,
  };
}

/**
 * O push único do fim do silêncio quando ficou mais de um aviso (ADR 54): título fixo, corpo com
 * os primeiros títulos, etiqueta fixa (um resumo substitui o anterior no aparelho). Os tipos de
 * prazo vêm primeiro (ADR 56) — inclusive os que não pedem ação —, na ordem de chegada dentro de
 * cada grupo: o aviso das 00:03 não some atrás de alertas das 22 h.
 */
export function quietSummaryPayload(
  items: readonly { title: string; type?: string }[],
): PushPayload {
  const ordered = [
    ...items.filter((i) => announcesDeadline(i.type)),
    ...items.filter((i) => !announcesDeadline(i.type)),
  ];
  const titles = ordered
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
      /** Categoria afirmada por quem emite (ADR 56); só vale se o par (tipo, categoria) está no mapa. */
      passCategory?: QuietPassCategory;
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
      const category = passCategoryFor(params.type, params.passCategory);
      if (params.passCategory != null && category === null) {
        logger.warn(
          { type: params.type, passCategory: params.passCategory },
          'categoria fora da lista do ADR 56 para este tipo: vai como aviso comum',
        );
      }
      // "Não perturbe" (ADR 54) com o que a pessoa deixa sair (ADR 56): uma decisão só, aqui, no
      // instante do evento. Dentro da janela, o que não foi liberado fica marcado como retido e o
      // resumo ao fim cobre; in-app, socket e e-mail já saíram. 21:59:59 sai, 22:00:00 fica.
      const timing = pushTiming({
        zone,
        window,
        now,
        category,
        allowed: quietPassOf(user.push_quiet_pass) ?? [],
      });
      if (timing.hold) {
        if (params.notificationId) {
          await notificationsRepository.markPushHeld(params.notificationId, now);
        }
        logger.debug({ userId, type: params.type }, 'push retido pela janela de silêncio');
        return;
      }
      if (timing.breaksQuiet) {
        // Sai no silêncio por escolha da pessoa: prioridade alta e etiqueta própria. Nunca recebe
        // push_held_at, então não conta no cartão nem volta no resumo.
        logger.debug({ userId, type: params.type }, 'push saiu no silêncio por escolha da pessoa');
        await this.send(userId, buildPayload(params, { ownTag: true }), {
          ttlSeconds: timing.ttlSeconds,
          urgency: 'high',
        });
        return;
      }
      await this.send(userId, buildPayload(params), { ttlSeconds: timing.ttlSeconds });
    } catch (err) {
      logger.warn({ err, type: params.type }, 'push da notificação falhou');
    }
  },

  /**
   * Aviso de teste: fura o silêncio de propósito (ADR 54: é a pessoa apertando um botão olhando a
   * tela), independente da escolha do ADR 56; mas não fura o de um aparelho offline horas depois —
   * o TTL acaba no próximo início. Nunca vai com prioridade alta.
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

  /** A conta entrega trabalho? Só ela vê a escolha do que sai no silêncio (ADR 56). */
  deliversWork(userId: number): Promise<boolean> {
    return pushRepository.deliversWork(userId);
  },
};
