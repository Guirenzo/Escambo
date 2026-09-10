import type { AdminMetrics, Dispute } from '@escambo/types';
import { blocklist } from '../../config/blocklist';
import { HttpError } from '../../utils/http-error';
import { authRepository } from '../auth/auth.repository';
import { sessionRepository } from '../auth/session.repository';
import { contractsRepository } from '../contracts/contracts.repository';
import { cashSettlement } from '../contracts/contracts.service';
import { milestonesRepository } from '../contracts/milestones.repository';
import { disputesRepository } from '../disputes/disputes.repository';
import { toDispute } from '../disputes/disputes.service';
import { notificationsService } from '../notifications/notifications.service';
import { adminRepository } from './admin.repository';
import type { ResolveDisputeInput } from './admin.schema';

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
    if (dispute.status === 'resolved')
      throw new HttpError(409, 'Disputa já resolvida', 'already_resolved');

    const contract = await contractsRepository.findById(dispute.contract_id);
    if (!contract) throw new HttpError(404, 'Contratação não encontrada', 'contract_not_found');
    const paymentMode = contract.payment_mode ?? 'cash';
    const isCredits = paymentMode === 'credits';
    const isBarter = paymentMode === 'barter';
    // Retido para o freelancer: líquido em R$ ou créditos (inteiros); troca não tem escrow.
    // Por marcos, conta só o que ainda não foi liberado.
    const remaining =
      paymentMode === 'cash' ? await milestonesRepository.escrowRemaining(contract.id) : null;
    const escrowNet = isBarter
      ? 0
      : isCredits
        ? Math.round(Number(contract.freelancer_net))
        : remaining
          ? remaining.net
          : Number(contract.freelancer_net);
    const price = remaining ? remaining.price : Number(contract.price);

    let finalStatus: 'completed' | 'cancelled';
    let refundPercentage: number | null = null;

    if (input.resolution === 'release_freelancer') {
      finalStatus = 'completed';
      refundPercentage = 0;
    } else if (input.resolution === 'refund_client') {
      finalStatus = 'cancelled';
      refundPercentage = 100;
    } else {
      refundPercentage = input.refundPercentage ?? 0;
      finalStatus = 'completed';
    }

    // Cash: o cliente recebe a fração do PREÇO (inclui a parte proporcional da taxa) e o
    // freelancer a fração do LÍQUIDO. Créditos: sem taxa, a fração é sobre o mesmo montante.
    let releaseToFreelancer: number;
    let refundToClient: number;
    if (isCredits) {
      releaseToFreelancer = Math.round((escrowNet * (100 - refundPercentage)) / 100);
      refundToClient = escrowNet - releaseToFreelancer;
    } else if (isBarter) {
      releaseToFreelancer = 0;
      refundToClient = 0;
    } else {
      const s = cashSettlement(price, escrowNet, refundPercentage);
      releaseToFreelancer = s.releaseFreelancer;
      refundToClient = s.refundClient;
    }

    const ok = await disputesRepository.resolve({
      disputeId,
      adminId,
      contractId: contract.id,
      freelancerId: contract.freelancer_id,
      clientId: contract.client_id,
      paymentMode,
      escrowNet,
      releaseToFreelancer,
      refundToClient,
      contractFinalStatus: finalStatus,
      resolution: input.resolution,
      refundPercentage,
      note: input.note ?? null,
    });
    if (!ok) throw new HttpError(409, 'Não foi possível resolver a disputa', 'conflict');

    const outcome =
      input.resolution === 'release_freelancer'
        ? 'Valor do escrow liberado ao freelancer.'
        : input.resolution === 'refund_client'
          ? 'Valor do escrow devolvido ao cliente.'
          : `Divisão: ${refundPercentage}% devolvido ao cliente, o restante liberado ao freelancer.`;
    for (const uid of [contract.client_id, contract.freelancer_id]) {
      void notificationsService.notify(uid, {
        type: 'dispute_resolved',
        title: 'Disputa resolvida pela mediação',
        body: outcome,
        data: { contractId: contract.id, disputeId },
      });
    }

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
    // Efeito imediato: derruba sessões (refresh) e bloqueia o access token vigente.
    const user = await authRepository.findByUlid(ulid);
    if (user) {
      if (action === 'reactivate') {
        blocklist.delete(user.id);
      } else {
        blocklist.add(user.id);
        await sessionRepository.revokeAllForUser(user.id);
      }
    }
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
      inEscrow: Number(m.in_escrow),
      pendingWithdrawals: Number(m.pending_withdrawals),
      pendingWithdrawalsAmount: Number(m.pending_withdrawals_amount),
      depositsTotal: Number(m.deposits_total),
      usersBalance: Number(m.users_balance),
      pendingDeletions: Number(m.pending_deletions),
    };
  },
};
