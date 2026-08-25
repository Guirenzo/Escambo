import { ulid } from 'ulid';
import type { BarterAgreement, BarterStatus, Paginated } from '@escambo/types';
import { HttpError } from '../../utils/http-error';
import { contractsRepository } from '../contracts/contracts.repository';
import { barterRepository, type BarterRow } from './barter.repository';
import type { CreateBarterInput, ListBartersInput } from './barter.schema';

const PLATFORM_FEE_RATE = 0.15; // RN-066
const money = (v: number): number => Math.round(v * 100) / 100;

function toBarter(row: BarterRow): BarterAgreement {
  return {
    id: row.id,
    ulid: row.ulid,
    proposerId: row.proposer_id,
    receiverId: row.receiver_id,
    offeredServiceId: row.offered_service_id,
    requestedServiceId: row.requested_service_id,
    offeredDescription: row.offered_description,
    requestedDescription: row.requested_description,
    estimatedValueOffered: Number(row.estimated_value_offered),
    estimatedValueRequested: Number(row.estimated_value_requested),
    cashDifference: Number(row.cash_difference),
    cashPayerId: row.cash_payer_id,
    platformFee: Number(row.platform_fee),
    status: row.status as BarterStatus,
    contractOfferedId: row.contract_offered_id,
    contractRequestedId: row.contract_requested_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Quem recebe a torna = a parte que ofertou MAIS valor (a que não paga a diferença). */
function tornaOf(row: BarterRow): { recipientId: number; amount: number } | null {
  const amount = Number(row.cash_difference);
  if (amount <= 0 || !row.cash_payer_id) return null;
  const recipientId = row.cash_payer_id === row.proposer_id ? row.receiver_id : row.proposer_id;
  return { recipientId, amount };
}

async function loadOr404(id: number): Promise<BarterRow> {
  const row = await barterRepository.findById(id);
  if (!row) throw new HttpError(404, 'Troca não encontrada', 'barter_not_found');
  return row;
}

export const barterService = {
  async propose(proposerId: number, input: CreateBarterInput): Promise<BarterAgreement> {
    if (input.receiverId === proposerId) {
      throw new HttpError(400, 'Você não pode propor uma troca consigo mesmo', 'self_barter');
    }
    const offered = input.estimatedValueOffered;
    const requested = input.estimatedValueRequested;

    // torna: a parte que recebe MENOS valor paga a diferença (RN-066)
    const cashDifference = money(Math.abs(offered - requested));
    let cashPayerId: number | null = null;
    if (offered > requested) cashPayerId = input.receiverId;
    else if (requested > offered) cashPayerId = proposerId;

    const platformFee = money(PLATFORM_FEE_RATE * Math.max(offered, requested)); // RN-066

    const id = await barterRepository.create({
      ulid: ulid(),
      proposerId,
      receiverId: input.receiverId,
      offeredServiceId: input.offeredServiceId ?? null,
      requestedServiceId: input.requestedServiceId ?? null,
      offeredDescription: input.offeredDescription ?? null,
      requestedDescription: input.requestedDescription ?? null,
      estimatedValueOffered: offered,
      estimatedValueRequested: requested,
      cashDifference,
      cashPayerId,
      platformFee,
    });

    return toBarter(await loadOr404(id));
  },

  async listMine(uid: number, input: ListBartersInput): Promise<Paginated<BarterAgreement>> {
    const rows = await barterRepository.listForUser(uid, input.limit, (input.page - 1) * input.limit);
    return { items: rows.map(toBarter), page: input.page, limit: input.limit };
  },

  async getById(id: number, uid: number): Promise<BarterAgreement> {
    const row = await loadOr404(id);
    if (row.proposer_id !== uid && row.receiver_id !== uid) {
      throw new HttpError(403, 'Você não participa desta troca', 'forbidden');
    }
    return toBarter(row);
  },

  /** Aceite bilateral (RN-067): gera os 2 contratos recíprocos + retém a torna. */
  async accept(id: number, uid: number): Promise<BarterAgreement> {
    const row = await loadOr404(id);
    if (row.receiver_id !== uid) {
      throw new HttpError(403, 'Apenas quem recebeu a proposta pode aceitar', 'forbidden');
    }
    if (row.status !== 'proposed') {
      throw new HttpError(409, `Troca não está mais disponível (${row.status})`, 'invalid_status');
    }

    const contractOffered = {
      ulid: ulid(),
      clientId: row.receiver_id, // recebe o serviço oferecido
      freelancerId: row.proposer_id, // entrega o serviço oferecido
      serviceId: row.offered_service_id,
      title: 'Troca — entrega do proponente',
      description: row.offered_description ?? 'Serviço oferecido na troca',
      price: Number(row.estimated_value_offered),
    };
    const contractRequested = {
      ulid: ulid(),
      clientId: row.proposer_id,
      freelancerId: row.receiver_id,
      serviceId: row.requested_service_id,
      title: 'Troca — entrega do receptor',
      description: row.requested_description ?? 'Serviço solicitado na troca',
      price: Number(row.estimated_value_requested),
    };

    const result = await barterRepository.accept({
      agreementId: id,
      acceptorId: uid,
      contractOffered,
      contractRequested,
      torna: tornaOf(row),
    });
    if (!result) {
      throw new HttpError(409, 'A troca mudou de estado; recarregue', 'conflict');
    }
    return toBarter(await loadOr404(id));
  },

  async reject(id: number, uid: number): Promise<void> {
    const row = await loadOr404(id);
    if (row.receiver_id !== uid) {
      throw new HttpError(403, 'Apenas quem recebeu a proposta pode recusar', 'forbidden');
    }
    const ok = await barterRepository.setStatusFromProposed(id, 'rejected');
    if (!ok) throw new HttpError(409, `Troca não está mais disponível (${row.status})`, 'invalid_status');
  },

  async cancel(id: number, uid: number): Promise<void> {
    const row = await loadOr404(id);
    if (row.proposer_id !== uid && row.receiver_id !== uid) {
      throw new HttpError(403, 'Você não participa desta troca', 'forbidden');
    }
    const ok = await barterRepository.setStatusFromProposed(id, 'cancelled');
    if (!ok) throw new HttpError(409, `Só é possível cancelar uma troca ainda proposta`, 'invalid_status');
  },

  /** Hook: um contrato da troca foi concluído — se AMBOS concluíram, fecha a troca e libera a torna. */
  async onLinkedContractCompleted(agreementId: number): Promise<void> {
    const row = await barterRepository.findById(agreementId);
    if (!row || row.status !== 'active') return;
    if (!row.contract_offered_id || !row.contract_requested_id) return;
    const [a, b] = await Promise.all([
      contractsRepository.findById(row.contract_offered_id),
      contractsRepository.findById(row.contract_requested_id),
    ]);
    if (a?.status === 'completed' && b?.status === 'completed') {
      await barterRepository.completeAndRelease(agreementId, tornaOf(row));
    }
  },

  /** Hook: um contrato da troca foi cancelado — a troca inteira entra em disputa (RN-067). */
  async onLinkedContractCancelled(agreementId: number): Promise<void> {
    const row = await barterRepository.findById(agreementId);
    if (!row || row.status !== 'active') return;
    await barterRepository.disputeAndRefund(agreementId, tornaOf(row));
  },
};
