import { logger } from '../config/logger';
import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { settingsRepository } from '../modules/settings/settings.repository';

/**
 * Aprovação tácita (RN): entrega registrada pelo freelancer e sem resposta do cliente por
 * `tacit_approval_days` dias (configuração da plataforma, padrão 5) é aprovada automaticamente,
 * liberando o escrow. Cada contrato é tratado isoladamente: uma falha não bloqueia os demais.
 */

export const DEFAULT_TACIT_APPROVAL_DAYS = 5;

export interface TacitApprovalResult {
  days: number;
  approved: number[];
  failed: number[];
}

export async function runTacitApproval(): Promise<TacitApprovalResult> {
  const days = await settingsRepository.getNumber(
    'tacit_approval_days',
    DEFAULT_TACIT_APPROVAL_DAYS,
  );
  const due = await contractsRepository.findDeliveredOlderThan(days);
  const result: TacitApprovalResult = { days, approved: [], failed: [] };

  for (const contract of due) {
    try {
      await contractsService.approveTacitly(contract.id, days);
      result.approved.push(contract.id);
      logger.info({ contractId: contract.id, days }, 'aprovação tácita aplicada');
    } catch (err) {
      result.failed.push(contract.id);
      logger.warn({ err, contractId: contract.id }, 'aprovação tácita falhou');
    }
  }
  return result;
}
