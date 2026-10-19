import { ulid } from 'ulid';
import type { Dispute, DisputeReason, DisputeResolution, DisputeStatus } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { formatDue } from '../../utils/timezone';
import { contractsRepository } from '../contracts/contracts.repository';
import { notificationsService } from '../notifications/notifications.service';
import { disputesRepository, type DisputeRow } from './disputes.repository';
import type { OpenDisputeInput } from './disputes.schema';

export function toDispute(r: DisputeRow): Dispute {
  return {
    id: r.id,
    ulid: r.ulid,
    contractId: r.contract_id,
    openedBy: r.opened_by,
    reason: r.reason as DisputeReason,
    description: r.description,
    status: r.status as DisputeStatus,
    resolution: r.resolution as DisputeResolution | null,
    refundPercentage: r.refund_percentage,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export const disputesService = {
  async open(userId: number, input: OpenDisputeInput): Promise<Dispute> {
    const contract = await contractsRepository.findById(input.contractId);
    if (!contract) throw new HttpError(404, 'Contratação não encontrada', 'contract_not_found');
    if (contract.client_id !== userId && contract.freelancer_id !== userId) {
      throw new HttpError(403, 'Você não participa desta contratação', 'forbidden');
    }
    const result = await disputesRepository.createManual({
      ulid: ulid(),
      contractId: input.contractId,
      openedBy: userId,
      reason: input.reason,
      description: input.description,
    });
    if ('refused' in result && result.refused === 'too_early') {
      throw new HttpError(
        409,
        result.opensAt
          ? `A disputa abre a partir de ${formatDue(result.opensAt, result.requesterZone)}. Até lá, tente se acertar pelo chat.`
          : 'A disputa ainda não está disponível nesta contratação. Tente se acertar pelo chat.',
        'dispute_too_early',
        { opensAt: result.opensAt?.toISOString() ?? null },
      );
    }
    if ('refused' in result) {
      throw new HttpError(
        409,
        'A contratação não está em um estado que permite disputa',
        'not_disputable',
      );
    }
    const { id } = result;
    // A outra parte fica sabendo na hora; a mediação (admin) vê a disputa no painel.
    const other = contract.client_id === userId ? contract.freelancer_id : contract.client_id;
    void notificationsService.notify(other, {
      type: 'dispute_opened',
      title: 'Disputa aberta na contratação',
      body: 'A mediação do Escambo vai analisar e decidir sobre o valor em escrow.',
      data: { contractId: input.contractId, disputeId: id },
    });
    return toDispute((await disputesRepository.findById(id))!);
  },

  async listMine(userId: number): Promise<Dispute[]> {
    return (await disputesRepository.listForUser(userId)).map(toDispute);
  },

  async getById(id: number, userId: number): Promise<Dispute> {
    const dispute = await disputesRepository.findById(id);
    if (!dispute) throw new HttpError(404, 'Disputa não encontrada', 'dispute_not_found');
    const contract = await contractsRepository.findById(dispute.contract_id);
    if (!contract || (contract.client_id !== userId && contract.freelancer_id !== userId)) {
      throw new HttpError(403, 'Você não participa desta disputa', 'forbidden');
    }
    return toDispute(dispute);
  },
};
