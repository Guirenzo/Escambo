import { logger } from '../config/logger';
import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { milestonesRepository } from '../modules/contracts/milestones.repository';
import { clock } from '../utils/clock';
import { dayZones } from '../utils/human-hours';

/**
 * Aprovação tácita (RN-024, ADR 57): entrega sem resposta do cliente até a hora gravada na
 * entrega (`tacit_approval_days` corridos depois, nunca de noite no fuso dele) é aprovada
 * automaticamente, liberando o escrow. Só age sobre clientes num fuso em que é dia. Cada contrato
 * é tratado isoladamente: uma falha não bloqueia os demais.
 */

export { DEFAULT_TACIT_APPROVAL_DAYS } from '../modules/contracts/deadline-grace';

export interface TacitApprovalResult {
  /** Fusos em que era dia na rodada; vazio = nada foi feito. */
  zones: string[];
  approved: number[];
  failed: number[];
  /** Marcos aprovados tacitamente (escrow por marcos). */
  milestones: number[];
}

export async function runTacitApproval(now: Date = clock.now()): Promise<TacitApprovalResult> {
  const zones = dayZones(now);
  const result: TacitApprovalResult = { zones, approved: [], failed: [], milestones: [] };
  if (zones.length === 0) return result;

  for (const contract of await contractsRepository.findApprovalDue(now, zones)) {
    try {
      await contractsService.approveTacitly(contract.id, now);
      result.approved.push(contract.id);
      logger.info({ contractId: contract.id }, 'aprovação tácita aplicada');
    } catch (err) {
      result.failed.push(contract.id);
      logger.warn({ err, contractId: contract.id }, 'aprovação tácita falhou');
    }
  }
  for (const m of await milestonesRepository.findApprovalDue(now, zones)) {
    try {
      const ok = await contractsService.approveMilestoneTacitly(m, now);
      if (ok) result.milestones.push(m.id);
    } catch (err) {
      result.failed.push(m.contract_id);
      logger.warn({ err, milestoneId: m.id }, 'aprovação tácita do marco falhou');
    }
  }
  return result;
}
