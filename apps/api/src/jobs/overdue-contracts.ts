import { logger } from '../config/logger';
import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { milestonesRepository } from '../modules/contracts/milestones.repository';
import { DEFAULT_DEADLINE_GRACE_HOURS } from '../modules/contracts/deadline-grace';
import { settingsRepository } from '../modules/settings/settings.repository';
import { clock } from '../utils/clock';
import { dayZones } from '../utils/human-hours';

/**
 * Job RN-028/RN-029 (ADR 57), em fases, para nenhuma contratação sem entrega ficar em estado
 * indefinido — e nada de madrugada: cada fase só age sobre quem está num fuso em que é dia.
 *  0. pedido de extensão sem resposta até a hora dita → expira como recusa (fuso do cliente);
 *  1. prazo vencido sem nenhuma entrega, a partir das 9h depois dele → aviso às duas partes, uma
 *     vez, com o fim da carência gravado (fuso de quem entrega);
 *  2. na hora gravada, ainda sem entrega nem extensão aceita → a plataforma abre a disputa
 *     (motivo "prazo"), congelando o escrow para a mediação;
 *  3. marco financiado nunca entregue com o prazo próprio vencido → aviso às duas partes (uma vez
 *     por marco), sem disputa: quem manda na mediação é o prazo da contratação.
 * Com o trabalho entregue o prazo não cobra mais (R-VEZ): revisão e marcos entregues ficam fora.
 */

export { DEFAULT_DEADLINE_GRACE_HOURS } from '../modules/contracts/deadline-grace';

export interface OverdueContractsResult {
  graceHours: number;
  /** Fusos em que era dia na rodada; vazio = nada foi feito. */
  zones: string[];
  /** Pedidos de extensão expirados nesta rodada. */
  expired: number[];
  notified: number[];
  disputed: number[];
  /** Marcos avisados nesta rodada. */
  milestones: number[];
  failed: number[];
}

export async function runOverdueContracts(
  now: Date = clock.now(),
): Promise<OverdueContractsResult> {
  const graceHours = await settingsRepository.getNumber(
    'deadline_grace_hours',
    DEFAULT_DEADLINE_GRACE_HOURS,
  );
  const zones = dayZones(now);
  const result: OverdueContractsResult = {
    graceHours,
    zones,
    expired: [],
    notified: [],
    disputed: [],
    milestones: [],
    failed: [],
  };
  if (zones.length === 0) return result;

  for (const row of await contractsRepository.findExtensionsToExpire(now, zones)) {
    try {
      if (await contractsService.expireExtension(row, graceHours, now)) result.expired.push(row.id);
    } catch (err) {
      result.failed.push(row.id);
      logger.error({ contractId: row.id, err }, 'falha ao expirar pedido de extensão');
    }
  }

  for (const row of await contractsRepository.findOverdueUnnoticed(now, zones)) {
    try {
      if (await contractsService.notifyOverdue(row, graceHours, now)) result.notified.push(row.id);
    } catch (err) {
      result.failed.push(row.id);
      logger.error({ contractId: row.id, err }, 'falha ao avisar prazo estourado');
    }
  }

  for (const row of await contractsRepository.findGraceEnded(now, zones)) {
    try {
      const disputeId = await contractsService.openOverdueDispute(row, now);
      if (disputeId !== null) {
        result.disputed.push(row.id);
        logger.info(
          { contractId: row.id, disputeId },
          'disputa aberta por prazo estourado (RN-029)',
        );
      }
    } catch (err) {
      result.failed.push(row.id);
      logger.error({ contractId: row.id, err }, 'falha ao abrir disputa por prazo');
    }
  }

  for (const m of await milestonesRepository.findOverdueUnnoticed(now, zones)) {
    try {
      if (await contractsService.notifyMilestoneOverdue(m, now)) result.milestones.push(m.id);
    } catch (err) {
      result.failed.push(m.contract_id);
      logger.error(
        { contractId: m.contract_id, milestoneId: m.id, err },
        'falha ao avisar marco atrasado',
      );
    }
  }
  return result;
}
