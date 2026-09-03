import type { AdminMetrics, Dispute } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { contractsRepository } from '../contracts/contracts.repository';
import { disputesRepository } from '../disputes/disputes.repository';
import { toDispute } from '../disputes/disputes.service';
import { adminRepository } from './admin.repository';
import type { ResolveDisputeInput } from './admin.schema';

const money = (v: number): number => Math.round(v * 100) / 100;

export const adminService = {
  async listOpenDisputes(): Promise<Dispute[]> {
    return (await disputesRepository.listOpen()).map(toDispute);
  },

  /** Resolve a disputa aplicando a decisão de escrow (RN-063). */
  async resolveDispute(
    adminId: number,
    disputeId: number,
    input: ResolveDisputeInput,
  ): Promise<Dispute> {
    const dispute = await disputesRepository.findById(disputeId);
    if (!dispute) throw new HttpError(404, 'Disputa não encontrada', 'dispute_not_found');
    if (dispute.status === 'resolved') throw new HttpError(409, 'Disputa já resolvida', 'already_resolved');

    const contract = await contractsRepository.findById(dispute.contract_id);
    if (!contract) throw new HttpError(404, 'Contratação não encontrada', 'contract_not_found');
    const escrowNet = Number(contract.freelancer_net);

    let releaseToFreelancer = 0;
    let finalStatus: 'completed' | 'cancelled';
    let refundPercentage: number | null = null;

    if (input.resolution === 'release_freelancer') {
      releaseToFreelancer = escrowNet;
      finalStatus = 'completed';
    } else if (input.resolution === 'refund_client') {
      releaseToFreelancer = 0;
      finalStatus = 'cancelled';
      refundPercentage = 100;
    } else {
      refundPercentage = input.refundPercentage ?? 0;
      releaseToFreelancer = money(escrowNet * (1 - refundPercentage / 100));
      finalStatus = 'completed';
    }

    const ok = await disputesRepository.resolve({
      disputeId,
      adminId,
      contractId: contract.id,
      freelancerId: contract.freelancer_id,
      escrowNet,
      releaseToFreelancer,
      contractFinalStatus: finalStatus,
      resolution: input.resolution,
      refundPercentage,
      note: input.note ?? null,
    });
    if (!ok) throw new HttpError(409, 'Não foi possível resolver a disputa', 'conflict');

    return toDispute((await disputesRepository.findById(disputeId))!);
  },

  /** Suspende / bane / reativa um usuário (RN-007). */
  async moderateUser(
    adminId: number,
    ulid: string,
    action: 'suspend' | 'ban' | 'reactivate',
  ): Promise<void> {
    const statusMap = { suspend: 'suspended', ban: 'banned', reactivate: 'active' } as const;
    const ok = await adminRepository.setUserStatus(ulid, statusMap[action]);
    if (!ok) throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    await adminRepository.recordAction(adminId, `user_${action}`, 'user', null, `ulid=${ulid}`);
  },

  async getMetrics(): Promise<AdminMetrics> {
    const m = await adminRepository.metrics();
    return {
      users: m.users,
      freelancers: m.freelancers,
      contracts: m.contracts,
      completedContracts: m.completed_contracts,
      openDisputes: m.open_disputes,
      platformFees: Number(m.platform_fees),
    };
  },
};
