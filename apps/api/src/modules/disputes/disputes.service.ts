import { ulid } from 'ulid';
import type { Dispute, DisputeReason, DisputeResolution, DisputeStatus } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { contractsRepository } from '../contracts/contracts.repository';
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
    const id = await disputesRepository.create({
      ulid: ulid(),
      contractId: input.contractId,
      openedBy: userId,
      reason: input.reason,
      description: input.description,
    });
    if (id === null) {
      throw new HttpError(409, 'A contratação não está em um estado que permite disputa', 'not_disputable');
    }
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
