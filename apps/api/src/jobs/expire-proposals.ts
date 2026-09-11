import { logger } from '../config/logger';
import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { settingsRepository } from '../modules/settings/settings.repository';

/**
 * Job RN-021: proposta sem resposta do freelancer por `proposal_expiry_hours` horas
 * (configuração da plataforma, padrão 72) expira — vira 'cancelled' com a nota do motivo e a
 * reserva da carteira volta ao cliente, que é avisado. Idempotente: a transição só se aplica
 * se a proposta ainda estiver pendente.
 */

export const DEFAULT_PROPOSAL_EXPIRY_HOURS = 72;

export interface ExpireProposalsResult {
  hours: number;
  expired: number[];
  failed: number[];
}

export async function runExpireProposals(): Promise<ExpireProposalsResult> {
  const hours = await settingsRepository.getNumber(
    'proposal_expiry_hours',
    DEFAULT_PROPOSAL_EXPIRY_HOURS,
  );
  const result: ExpireProposalsResult = { hours, expired: [], failed: [] };
  for (const contract of await contractsRepository.findPendingOlderThan(hours)) {
    try {
      await contractsService.expireProposal(contract.id, hours);
      result.expired.push(contract.id);
      logger.info({ contractId: contract.id, hours }, 'proposta expirada (RN-021)');
    } catch (err) {
      result.failed.push(contract.id);
      logger.error({ contractId: contract.id, err }, 'falha ao expirar proposta');
    }
  }
  return result;
}
