import webpush from 'web-push';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { PUSH_TTL_MAX_SECONDS } from './quiet-hours';

/**
 * Entrega de push atrás de interface, no mesmo desenho do e-mail e do gateway de pagamento
 * (ADR 52).
 * - `simulated`: nada sai da máquina; a entrega fica no log e na própria assinatura
 *   (last_sent_at), que é o que a demo e os testes conferem.
 * - `webpush`: Web Push de verdade, com as chaves VAPID de PUSH_PUBLIC_KEY/PUSH_PRIVATE_KEY.
 * - `off`: o canal inteiro desligado.
 *
 * Sem chaves configuradas, um par é gerado na subida e vale enquanto o processo viver: a demo
 * funciona sem segredo no repositório. Isso só serve para o provedor simulado — com envio real,
 * chave por processo quebraria o cluster, então `webpush` exige as duas chaves do ambiente.
 */

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** O que fazer com a assinatura depois de uma tentativa. */
export type PushResult = 'sent' | 'gone' | 'failed';

/**
 * Resposta do serviço de push → destino da assinatura. 404 e 410 são o aparelho que desfez a
 * assinatura; 401 e 403 são a chave que não bate mais (troca de VAPID), e a assinatura também
 * deixa de servir. O resto é tentativa perdida, que vale repetir no próximo aviso.
 */
export const resultForStatus = (status: number | undefined): PushResult =>
  status === 404 || status === 410 || status === 401 || status === 403 ? 'gone' : 'failed';

/** Quanto tempo o serviço de push pode segurar o aviso para um aparelho offline (ADR 54). */
export interface PushSendOptions {
  ttlSeconds?: number;
  /**
   * Prioridade de entrega (RFC 8030 §5.3). Só o aviso que sai durante o silêncio vai com 'high',
   * para o serviço de push não esperar o aparelho sair da economia de bateria (ADR 56). Não passa
   * pelo "não perturbe" do sistema. Sem pedido, a chave nem vai e o serviço recebe 'normal'.
   */
  urgency?: 'high';
}

export interface PushProvider {
  readonly name: 'simulated' | 'webpush';
  send(target: PushTarget, payload: PushPayload, opts?: PushSendOptions): Promise<PushResult>;
}

let keys: { publicKey: string; privateKey: string } | null = null;

/** Chaves VAPID: as do ambiente ou um par gerado na subida (demo e desenvolvimento). */
export function vapidKeys(): { publicKey: string; privateKey: string } {
  if (keys) return keys;
  if (env.PUSH_PUBLIC_KEY && env.PUSH_PRIVATE_KEY) {
    keys = { publicKey: env.PUSH_PUBLIC_KEY, privateKey: env.PUSH_PRIVATE_KEY };
  } else if (env.PUSH_PROVIDER === 'webpush') {
    // Chave por processo com envio real seria pior que não ter push: em cluster, cada instância
    // assinaria com uma chave e o serviço de push recusaria as assinaturas das outras.
    throw new Error(
      'PUSH_PROVIDER=webpush exige PUSH_PUBLIC_KEY e PUSH_PRIVATE_KEY (gere com "npx web-push generate-vapid-keys")',
    );
  } else {
    keys = webpush.generateVAPIDKeys();
    logger.info(
      { publicKey: keys.publicKey },
      'chaves VAPID geradas para esta subida (configure PUSH_PUBLIC_KEY/PUSH_PRIVATE_KEY para fixar)',
    );
  }
  return keys;
}

export const simulatedPushProvider: PushProvider = {
  name: 'simulated',
  async send(target, payload, opts) {
    logger.info(
      {
        endpoint: target.endpoint.slice(0, 60),
        title: payload.title,
        urgency: opts?.urgency ?? 'normal',
      },
      'push (simulado) entregue',
    );
    return 'sent';
  },
};

export const webPushProvider: PushProvider = {
  name: 'webpush',
  async send(target, payload, opts) {
    const { publicKey, privateKey } = vapidKeys();
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: { subject: env.PUSH_SUBJECT, publicKey, privateKey },
          TTL: opts?.ttlSeconds ?? PUSH_TTL_MAX_SECONDS,
          ...(opts?.urgency ? { urgency: opts.urgency } : {}),
        },
      );
      return 'sent';
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const result = resultForStatus(status);
      if (result === 'failed') logger.warn({ err, status }, 'push não entregue');
      return result;
    }
  },
};

/** Desligado: não entrega nada e não mexe na assinatura. */
export const offPushProvider: PushProvider = {
  name: 'simulated',
  async send() {
    return 'failed';
  },
};

export const activePushProvider = (): PushProvider => {
  if (env.PUSH_PROVIDER === 'webpush') return webPushProvider;
  if (env.PUSH_PROVIDER === 'off') return offPushProvider;
  return simulatedPushProvider;
};
