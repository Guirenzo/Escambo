import { logger } from '../config/logger';
import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { clock } from '../utils/clock';
import { dayZones } from '../utils/human-hours';

/**
 * Job RN-021 (ADR 57): proposta sem resposta do freelancer até a hora gravada na criação
 * (`proposal_expiry_hours` depois, ou antes do prazo de entrega, nunca de noite no fuso dele)
 * expira — vira 'cancelled' com a nota do motivo, a reserva da carteira volta ao cliente e os
 * dois são avisados. Só age sobre freelancers num fuso em que é dia. Idempotente: a transição só
 * se aplica se a proposta ainda estiver pendente e vencida.
 */

export { DEFAULT_PROPOSAL_EXPIRY_HOURS } from '../modules/contracts/deadline-grace';

export interface ExpireProposalsResult {
  /** Fusos em que era dia na rodada; vazio = nada foi feito. */
  zones: string[];
  expired: number[];
  failed: number[];
}

export async function runExpireProposals(now: Date = clock.now()): Promise<ExpireProposalsResult> {
  const zones = dayZones(now);
  const result: ExpireProposalsResult = { zones, expired: [], failed: [] };
  if (zones.length === 0) return result;
  for (const contract of await contractsRepository.findProposalsDue(now, zones)) {
    try {
      await contractsService.expireProposal(contract.id, now);
      result.expired.push(contract.id);
      logger.info({ contractId: contract.id }, 'proposta expirada (RN-021)');
    } catch (err) {
      result.failed.push(contract.id);
      logger.error({ contractId: contract.id, err }, 'falha ao expirar proposta');
    }
  }
  return result;
}
