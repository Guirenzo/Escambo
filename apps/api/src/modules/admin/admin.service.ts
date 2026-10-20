import type {
  AdminAccountLookup,
  AdminMetrics,
  Dispute,
  UserRole,
  UserStatus,
} from '@escambo/types';
import { blocklist } from '../../config/blocklist';
import { env } from '../../config/env';
import { realtime } from '../../config/realtime';
import { clock } from '../../utils/clock';
import { HttpError } from '../../utils/http-error';
import { authFacade } from '../auth/auth.facade';
import { contractsFacade } from '../contracts/contracts.facade';
import { cashSettlement } from '../contracts/contracts.service';
import { disputesFacade } from '../disputes/disputes.facade';
import { toDispute } from '../disputes/disputes.service';
import { mailService } from '../mail/mail.service';
import { notificationsService } from '../notifications/notifications.service';
import { adminRepository } from './admin.repository';
import type { ResolveDisputeInput } from './admin.schema';

export const adminService = {
  async listOpenDisputes(): Promise<Dispute[]> {
    return (await disputesFacade.listOpen()).map(toDispute);
  },

  /** Resolve a disputa aplicando a decisão de escrow (RN-063). */
  async resolveDispute(
    adminId: number,
    disputeId: number,
    input: ResolveDisputeInput,
  ): Promise<Dispute> {
    const dispute = await disputesFacade.findById(disputeId);
    if (!dispute) throw new HttpError(404, 'Disputa não encontrada', 'dispute_not_found');
    if (dispute.status === 'resolved')
      throw new HttpError(409, 'Disputa já resolvida', 'already_resolved');

    const contract = await contractsFacade.findById(dispute.contract_id);
    if (!contract) throw new HttpError(404, 'Contratação não encontrada', 'contract_not_found');
    const paymentMode = contract.payment_mode ?? 'cash';
    const isCredits = paymentMode === 'credits';
    const isBarter = paymentMode === 'barter';
    // Retido para o freelancer: líquido em R$ ou créditos (inteiros); troca não tem escrow.
    // Por marcos, conta só o que ainda não foi liberado.
    const remaining = isBarter ? null : await contractsFacade.escrowRemaining(contract.id);
    const escrowNet = isBarter
      ? 0
      : isCredits
        ? Math.round(remaining ? remaining.net : Number(contract.freelancer_net))
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

    // A divisão é decidida pelo valor, não pela porcentagem: no arredondamento, 99% de 10 créditos
    // libera 0 e devolve tudo, e a contratação fecharia 'completed' (XP, avaliação). Troca não tem
    // escrow e segue como está.
    if (input.resolution === 'partial_split' && !isBarter) {
      if (releaseToFreelancer <= 0) {
        throw new HttpError(
          422,
          'Com essa porcentagem nada vai ao freelancer e tudo volta ao cliente: use "Devolver ao cliente" (refund_client).',
          'split_one_sided',
        );
      }
      if (refundToClient <= 0) {
        throw new HttpError(
          422,
          'Com essa porcentagem nada volta ao cliente e tudo vai ao freelancer: use "Liberar ao freelancer" (release_freelancer).',
          'split_one_sided',
        );
      }
    }

    const ok = await disputesFacade.resolve({
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
      source: 'user',
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

    return toDispute((await disputesFacade.findById(disputeId))!);
  },

  /** Suspende / bane / reativa um usuário (RN-007). */
  async moderateUser(
    adminId: number,
    ulid: string,
    action: 'suspend' | 'ban' | 'reactivate',
  ): Promise<void> {
    const statusMap = { suspend: 'suspended', ban: 'banned', reactivate: 'active' } as const;
    const user = await authFacade.findByUlid(ulid);
    if (!user) throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    // Admin (inclusive o próprio) não é suspenso nem banido por aqui: sem essa trava, um clique
    // tira o único admin do painel e a saída é mexer no banco. Reativar continua valendo.
    if (action !== 'reactivate' && user.role === 'admin') {
      throw new HttpError(
        409,
        'Administradores não são suspensos nem banidos pelo painel.',
        'cannot_moderate_admin',
      );
    }
    const ok = await adminRepository.setUserStatus(ulid, statusMap[action]);
    if (!ok) throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    // Suspensão mantém sessões para consulta. Banimento revoga e desconecta;
    // cada request/evento também confere o estado atual no banco.
    if (action === 'reactivate') {
      blocklist.delete(user.id);
    } else {
      blocklist.add(user.id, statusMap[action]);
      if (action === 'ban') await authFacade.revokeAllSessions(user.id);
    }
    await realtime.emitToUser(user.id, 'account:status', { status: statusMap[action] });
    if (action === 'ban') realtime.disconnectUser(user.id);
    await adminRepository.recordAction(adminId, `user_${action}`, 'user', user.id, `ulid=${ulid}`);
  },

  /** Atendimento (ADR 66): a conta pelo e-mail, com a situação da verificação em duas etapas. */
  async lookupAccount(email: string): Promise<AdminAccountLookup> {
    const row = await authFacade.findAccountByEmail(email);
    if (!row) throw new HttpError(404, 'Nenhuma conta com este e-mail', 'user_not_found');
    return {
      ulid: row.ulid,
      email: row.email,
      role: row.role as UserRole,
      status: row.status as UserStatus,
      mfaEnabled: Number(row.mfa_enabled) === 1,
      createdAt: new Date(row.created_at).toISOString(),
    };
  },

  /**
   * Recuperação pelo atendimento (ADR 66): quem perdeu o celular e os códigos de recuperação fala
   * com o suporte, que confere a identidade fora do sistema e desativa a 2FA por aqui. As sessões
   * da conta caem (quem estiver dentro sai), a ação fica na trilha do admin com o motivo e o
   * titular é avisado por e-mail. A própria 2FA o admin desativa no perfil, com senha e código.
   */
  async resetMfa(
    adminId: number,
    ulid: string,
    reason: string,
  ): Promise<{ sessionsRevoked: number }> {
    const user = await authFacade.findByUlid(ulid);
    if (!user) throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    if (user.id === adminId) {
      throw new HttpError(
        400,
        'A sua própria verificação em duas etapas se desativa no seu perfil, com a senha e o código.',
        'cannot_reset_self',
      );
    }
    const removed = await authFacade.deleteMfa(user.id);
    if (removed === 0) {
      throw new HttpError(
        409,
        'Esta conta não tem a verificação em duas etapas ativa.',
        'mfa_not_enabled',
      );
    }
    const sessionsRevoked = await authFacade.revokeAllSessions(user.id);
    await adminRepository.recordAction(adminId, 'user_mfa_reset', 'user', user.id, reason);
    // Aviso de segurança ao titular, mesmo com os e-mails de novidades desligados (melhor esforço).
    await mailService.send({
      userId: user.id,
      to: user.email,
      template: 'notification',
      vars: {
        title: 'Verificação em duas etapas desativada pelo atendimento',
        body: 'A pedido feito ao suporte, a verificação em duas etapas da sua conta do Escambo foi desativada e as sessões abertas foram encerradas. Entre com a senha e ative de novo no seu perfil. Se você não pediu isso, troque a senha agora e fale com o suporte.',
        link: `${env.APP_URL.replace(/\/$/, '')}/perfil`,
        cta: 'Abrir o perfil',
      },
    });
    return { sessionsRevoked };
  },

  async getMetrics(): Promise<AdminMetrics> {
    const m = await adminRepository.metrics(clock.now());
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
      overdueWithdrawals: Number(m.overdue_withdrawals),
      depositsTotal: Number(m.deposits_total),
      usersBalance: Number(m.users_balance),
      pendingDeletions: Number(m.pending_deletions),
      supportOpen: Number(m.support_open),
      supportAwaitingReply: Number(m.support_awaiting_reply),
      supportSlaOverdue: Number(m.support_sla_overdue),
    };
  },
};
