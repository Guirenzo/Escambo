import type { StrikeSummary } from '@escambo/types';
import { settingsService } from '../settings/settings.service';
import { contentRemovalsRepository } from './content-removals.repository';

/**
 * Reincidência na moderação de imagens (ADR 41). Nada disso fica guardado: é calculado na hora a
 * partir das remoções, então uma contestação aceita tira a ocorrência e o bloqueio some junto.
 *  - ocorrência: remoção não revertida dentro da janela (strike_window_days);
 *  - bloqueio de envio: da segunda ocorrência em diante, strike_upload_block_days × (ocorrências −
 *    1), contado da remoção mais recente;
 *  - revisão da conta: ao chegar em strike_review_threshold, a moderação abre uma denúncia da conta.
 */

export const DAY_MS = 86_400_000;

export interface StrikePolicy {
  appealWindowDays: number;
  windowDays: number;
  blockDays: number;
  reviewThreshold: number;
}

export async function strikePolicy(): Promise<StrikePolicy> {
  const [appealWindowDays, windowDays, blockDays, reviewThreshold] = await Promise.all([
    settingsService.number('appeal_window_days'),
    settingsService.number('strike_window_days'),
    settingsService.number('strike_upload_block_days'),
    settingsService.number('strike_review_threshold'),
  ]);
  return { appealWindowDays, windowDays, blockDays, reviewThreshold };
}

/** Até quando o dono pode contestar uma remoção. */
export const appealDeadline = (removedAt: Date, appealWindowDays: number): Date =>
  new Date(new Date(removedAt).getTime() + appealWindowDays * DAY_MS);

/** Fim do bloqueio de envio, ou null quando não há bloqueio para esse número de ocorrências. */
export function uploadsBlockedUntil(
  strikes: number,
  lastRemovedAt: Date | null,
  blockDays: number,
): Date | null {
  if (strikes < 2 || blockDays <= 0 || !lastRemovedAt) return null;
  return new Date(new Date(lastRemovedAt).getTime() + blockDays * (strikes - 1) * DAY_MS);
}

/** Ocorrências do dono agora e, se ainda valer, até quando o envio de imagens está bloqueado. */
export async function strikeSummary(
  ownerId: number,
  now: Date = new Date(),
  policy?: StrikePolicy,
): Promise<StrikeSummary> {
  const p = policy ?? (await strikePolicy());
  const since = new Date(now.getTime() - p.windowDays * DAY_MS);
  const { strikes, imageStrikes, lastImage } = await contentRemovalsRepository.strikeStats(
    ownerId,
    since,
  );
  // O bloqueio de envio vem só das imagens; a revisão da conta conta tudo (ADR 44).
  const until = uploadsBlockedUntil(imageStrikes, lastImage, p.blockDays);
  return {
    strikes,
    imageStrikes,
    windowDays: p.windowDays,
    reviewThreshold: p.reviewThreshold,
    uploadsBlockedUntil: until && until.getTime() > now.getTime() ? until.toISOString() : null,
  };
}

// A data nos avisos sai no fuso da pessoa: utils/timezone.formatDateTime (ADR 46).
