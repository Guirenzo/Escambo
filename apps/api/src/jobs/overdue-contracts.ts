import { logger } from '../config/logger';
import { contractsRepository } from '../modules/contracts/contracts.repository';
import { contractsService } from '../modules/contracts/contracts.service';
import { settingsRepository } from '../modules/settings/settings.repository';

/**
 * Job RN-029, em duas fases, para nenhuma contratação ficar em estado indefinido:
 *  1. prazo vencido e ninguém avisado → aviso às duas partes (uma vez);
 *  2. `deadline_grace_hours` horas depois do aviso (padrão 24), ainda sem entrega nem extensão
 *     aprovada → a plataforma abre a disputa (motivo "prazo"), congelando o escrow para a mediação.
 * Um pedido de extensão pendente segura as duas fases: a decisão é do cliente.
 */

export const DEFAULT_DEADLINE_GRACE_HOURS = 24;

export interface OverdueContractsResult {
  graceHours: number;
  notified: number[];
  disputed: number[];
  failed: number[];
}

export async function runOverdueContracts(): Promise<OverdueContractsResult> {
  const graceHours = await settingsRepository.getNumber(
    'deadline_grace_hours',
    DEFAULT_DEADLINE_GRACE_HOURS,
  );
  const result: OverdueContractsResult = { graceHours, notified: [], disputed: [], failed: [] };

  for (const row of await contractsRepository.findOverdueUnnoticed()) {
    try {
      if (await contractsService.notifyOverdue(row, graceHours)) result.notified.push(row.id);
    } catch (err) {
      result.failed.push(row.id);
      logger.error({ contractId: row.id, err }, 'falha ao avisar prazo estourado');
    }
  }

  for (const row of await contractsRepository.findOverdueBeyondGrace(graceHours)) {
    try {
      const disputeId = await contractsService.openOverdueDispute(row, graceHours);
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
  return result;
}
