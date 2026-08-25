import { ulid } from 'ulid';
import type {
  CancelResult,
  Contract,
  ContractStatus,
  ContractStatusHistoryEntry,
  ContractWithHistory,
  Paginated,
} from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { barterService } from '../barter/barter.service';
import { gamificationService } from '../gamification/gamification.service';
import { walletService } from '../wallet/wallet.service';
import { contractsRepository, type ContractRow } from './contracts.repository';
import type { CreateContractInput, DeliverInput, ListContractsInput } from './contracts.schema';

const PLATFORM_FEE_RATE = 0.15; // RN-031

const money = (v: number): number => Math.round(v * 100) / 100;

function toContract(row: ContractRow): Contract {
  return {
    id: row.id,
    ulid: row.ulid,
    clientId: row.client_id,
    freelancerId: row.freelancer_id,
    serviceId: row.service_id,
    title: row.title,
    description: row.description,
    price: Number(row.price),
    platformFee: Number(row.platform_fee),
    freelancerNet: Number(row.freelancer_net),
    status: row.status as ContractStatus,
    deadlineAt: row.deadline_at ? new Date(row.deadline_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function loadOr404(id: number): Promise<ContractRow> {
  const row = await contractsRepository.findById(id);
  if (!row) throw new HttpError(404, 'Contratação não encontrada', 'contract_not_found');
  return row;
}

function assertParty(row: ContractRow, uid: number): void {
  if (row.client_id !== uid && row.freelancer_id !== uid) {
    throw new HttpError(403, 'Você não participa desta contratação', 'forbidden');
  }
}
function assertClient(row: ContractRow, uid: number): void {
  if (row.client_id !== uid) throw new HttpError(403, 'Ação exclusiva do cliente', 'forbidden');
}
function assertFreelancer(row: ContractRow, uid: number): void {
  if (row.freelancer_id !== uid) throw new HttpError(403, 'Ação exclusiva do freelancer', 'forbidden');
}
function assertStatus(row: ContractRow, allowed: ContractStatus[]): void {
  if (!allowed.includes(row.status as ContractStatus)) {
    throw new HttpError(409, `Ação não permitida no status "${row.status}"`, 'invalid_transition');
  }
}

/** Política de reembolso ao cancelar (RN-025). */
function refundPercentage(row: ContractRow): number {
  if (row.status === 'pending') return 100;
  if (!row.deadline_at) return 50;
  const created = new Date(row.created_at).getTime();
  const deadline = new Date(row.deadline_at).getTime();
  if (deadline <= created) return 0;
  const elapsed = (Date.now() - created) / (deadline - created);
  return elapsed < 0.5 ? 50 : 0;
}

async function applyTransition(params: {
  id: number;
  changedBy: number;
  from: string;
  to: string;
  note: string | null;
  timestampColumn?: 'accepted_at' | 'completed_at' | 'cancelled_at';
  walletEffect?: { userId: number; pendingDelta: number; balanceDelta: number };
}): Promise<void> {
  const ok = await contractsRepository.transition(params);
  if (!ok) {
    throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
  }
}

export const contractsService = {
  async create(clientId: number, input: CreateContractInput): Promise<Contract> {
    if (input.freelancerId === clientId) {
      throw new HttpError(400, 'Você não pode contratar a si mesmo', 'self_contract');
    }
    const platformFee = money(input.price * PLATFORM_FEE_RATE); // RN-031
    const freelancerNet = money(input.price - platformFee);

    const id = await contractsRepository.create({
      ulid: ulid(),
      clientId,
      freelancerId: input.freelancerId,
      serviceId: input.serviceId ?? null,
      title: input.title,
      description: input.description,
      price: input.price,
      platformFee,
      freelancerNet,
      deadlineAt: input.deadlineAt ?? null,
    });

    return toContract(await loadOr404(id));
  },

  async listMine(uid: number, input: ListContractsInput): Promise<Paginated<Contract>> {
    const rows = await contractsRepository.listForUser(
      uid,
      input.limit,
      (input.page - 1) * input.limit,
    );
    return { items: rows.map(toContract), page: input.page, limit: input.limit };
  },

  async getById(id: number, uid: number): Promise<ContractWithHistory> {
    const row = await loadOr404(id);
    assertParty(row, uid);
    const history = await contractsRepository.listHistory(id);
    const entries: ContractStatusHistoryEntry[] = history.map((h) => ({
      previousStatus: h.old_status as ContractStatus | null,
      status: h.new_status as ContractStatus,
      note: h.note,
      at: new Date(h.created_at).toISOString(),
    }));
    return { ...toContract(row), history: entries };
  },

  async accept(id: number, uid: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid); // RF-032
    assertStatus(row, ['pending']);
    // Ao aceitar, o valor líquido entra em escrow (balance_pending do freelancer) — RN-032.
    await walletService.ensure(row.freelancer_id);
    await applyTransition({
      id,
      changedBy: uid,
      from: row.status,
      to: 'accepted',
      note: null,
      timestampColumn: 'accepted_at',
      walletEffect: { userId: row.freelancer_id, pendingDelta: Number(row.freelancer_net), balanceDelta: 0 },
    });
    return toContract(await loadOr404(id));
  },

  async reject(id: number, uid: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid);
    assertStatus(row, ['pending']);
    await applyTransition({ id, changedBy: uid, from: row.status, to: 'rejected', note: null });
    return toContract(await loadOr404(id));
  },

  async deliver(id: number, uid: number, input: DeliverInput): Promise<Contract> {
    const row = await loadOr404(id);
    assertFreelancer(row, uid); // RF-035
    assertStatus(row, ['accepted', 'in_progress', 'revision_requested']);
    const ok = await contractsRepository.deliver({
      id,
      changedBy: uid,
      from: row.status,
      message: input.message,
      files: input.files ?? null,
    });
    if (!ok) throw new HttpError(409, 'A contratação mudou de estado; recarregue', 'conflict');
    return toContract(await loadOr404(id));
  },

  async approve(id: number, uid: number): Promise<Contract> {
    const row = await loadOr404(id);
    assertClient(row, uid); // RF-036/037: só o cliente aprova
    assertStatus(row, ['delivered']);
    // Contrato de troca não move dinheiro do serviço (é pago com serviço); só o fluxo cash libera escrow.
    const isBarter = row.payment_mode === 'barter';
    const net = Number(row.freelancer_net);
    await applyTransition({
      id,
      changedBy: uid,
      from: row.status,
      to: 'completed',
      note: null,
      timestampColumn: 'completed_at',
      ...(isBarter
        ? {}
        : { walletEffect: { userId: row.freelancer_id, pendingDelta: -net, balanceDelta: net } }),
    });
    // Efeitos secundários: nunca derrubam a aprovação/liberação do dinheiro.
    try {
      await gamificationService.onContractCompleted(row.freelancer_id, id);
    } catch (err) {
      console.error('gamificação (onContractCompleted) falhou:', err);
    }
    if (row.barter_agreement_id) {
      try {
        await barterService.onLinkedContractCompleted(row.barter_agreement_id);
      } catch (err) {
        console.error('troca (onLinkedContractCompleted) falhou:', err);
      }
    }
    return toContract(await loadOr404(id));
  },

  async requestRevision(id: number, uid: number, note: string | null): Promise<Contract> {
    const row = await loadOr404(id);
    assertClient(row, uid);
    assertStatus(row, ['delivered']);
    await applyTransition({ id, changedBy: uid, from: row.status, to: 'revision_requested', note });
    return toContract(await loadOr404(id));
  },

  async cancel(id: number, uid: number): Promise<CancelResult> {
    const row = await loadOr404(id);
    assertParty(row, uid);
    assertStatus(row, ['pending', 'accepted', 'in_progress']); // RN-025; após entrega vira disputa
    const refund = refundPercentage(row);
    // Troca não tem escrow por-contrato; o estorno da torna é tratado no nível da troca.
    const isBarter = row.payment_mode === 'barter';
    const escrowFunded = !isBarter && (row.status === 'accepted' || row.status === 'in_progress');
    const net = Number(row.freelancer_net);
    await applyTransition({
      id,
      changedBy: uid,
      from: row.status,
      to: 'cancelled',
      note: `Reembolso: ${refund}%`,
      timestampColumn: 'cancelled_at',
      ...(escrowFunded
        ? { walletEffect: { userId: row.freelancer_id, pendingDelta: -net, balanceDelta: 0 } }
        : {}),
    });
    if (row.barter_agreement_id) {
      try {
        await barterService.onLinkedContractCancelled(row.barter_agreement_id);
      } catch (err) {
        console.error('troca (onLinkedContractCancelled) falhou:', err);
      }
    }
    return { status: 'cancelled', refundPercentage: refund };
  },
};
