import { ulid } from 'ulid';
import type {
  BarterAgreement,
  BarterStatus,
  BarterValueSource,
  Paginated,
  TornaStatus,
} from '@escambo/types';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-error';
import { contractsFacade } from '../contracts/contracts.facade';
import { gamificationService } from '../gamification/gamification.service';
import { notificationsService } from '../notifications/notifications.service';
import {
  barterRepository,
  type BarterRow,
  type CatalogService,
  type TornaHold,
} from './barter.repository';
import type { CreateBarterInput, ListBartersInput } from './barter.schema';
import { settingsService } from '../settings/settings.service';

/** Arredonda em centavos, meio centavo para cima, sem cair no 28333.4999… do ponto flutuante. */
const money = (v: number): number => Math.sign(v) * (Math.round(Math.abs(v) * 100 + 1e-6) / 100);
const brl = (v: number): string =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * O valor de um lado pelo catálogo (RF-084): só o serviço de preço fechado tem um. A combinar, sem
 * preço ou por hora (o preço é da hora, não do trabalho), o catálogo não diz quanto vale a troca.
 */
export function catalogValue(service: CatalogService | null): number | null {
  if (service?.priceType !== 'fixed' || service.price == null || !(service.price > 0)) return null;
  return money(service.price);
}

const SIDE = {
  offered: {
    mismatch: 'O serviço que você oferece custa',
    mismatchHint: 'Para outro valor, mude o preço do serviço ou descreva a oferta.',
    serviceRequired:
      'O serviço que você oferece não tem preço fechado no catálogo (a combinar ou por hora): informe quanto ele vale nesta troca.',
    describedRequired: 'Informe quanto vale o que você oferece.',
  },
  requested: {
    mismatch: 'O serviço pedido custa',
    mismatchHint: 'Atualize a tela e confira a torna antes de enviar.',
    serviceRequired:
      'O serviço pedido não tem preço fechado no catálogo (a combinar ou por hora): informe quanto ele vale nesta troca.',
    describedRequired: 'Informe quanto vale o que você pede.',
  },
} as const;

/**
 * O valor de um lado da troca (RF-084, RN-066: o sistema estima cada lado). Com preço fechado no
 * catálogo, vale o catálogo: sem valor na proposta, ele é usado; com um valor diferente, a proposta
 * é recusada (422 estimate_mismatch), porque a torna sai da carteira e a pessoa precisa ver na tela
 * o valor que vai ser reservado. Sem preço fechado (a combinar, por hora, sem preço) ou com a
 * oferta descrita, vale o valor informado pelo proponente, que então é obrigatório.
 */
export function estimateSide(
  side: keyof typeof SIDE,
  service: CatalogService | null,
  informed: number | undefined,
): { value: number; source: BarterValueSource } {
  const text = SIDE[side];
  const catalog = catalogValue(service);
  if (catalog != null) {
    if (informed !== undefined && Math.round(informed * 100) !== Math.round(catalog * 100)) {
      throw new HttpError(
        422,
        `${text.mismatch} ${brl(catalog)} no catálogo, e a troca usa esse valor (RN-066). ${text.mismatchHint}`,
        'estimate_mismatch',
      );
    }
    return { value: catalog, source: 'catalog' };
  }
  if (informed === undefined) {
    throw new HttpError(
      422,
      service ? text.serviceRequired : text.describedRequired,
      'estimate_required',
    );
  }
  return { value: informed, source: 'informed' };
}

/** Quem recebe a torna: a parte que não é o pagador. */
const tornaReceiverOf = (row: BarterRow): number | null =>
  row.cash_payer_id == null
    ? null
    : row.cash_payer_id === row.proposer_id
      ? row.receiver_id
      : row.proposer_id;

function toBarter(row: BarterRow): BarterAgreement {
  const torna = Number(row.cash_difference);
  const fee = Number(row.platform_fee);
  return {
    id: row.id,
    ulid: row.ulid,
    proposerId: row.proposer_id,
    receiverId: row.receiver_id,
    offeredServiceId: row.offered_service_id,
    requestedServiceId: row.requested_service_id,
    offeredServiceTitle: row.offered_title ?? null,
    requestedServiceTitle: row.requested_title ?? null,
    offeredDescription: row.offered_description,
    requestedDescription: row.requested_description,
    estimatedValueOffered: Number(row.estimated_value_offered),
    estimatedValueRequested: Number(row.estimated_value_requested),
    // Antes da 1.45.0 os dois valores eram digitados pelo proponente.
    offeredValueSource: row.offered_value_source ?? 'informed',
    requestedValueSource: row.requested_value_source ?? 'informed',
    cashDifference: torna,
    cashPayerId: row.cash_payer_id,
    platformFee: fee,
    tornaNet: money(Math.max(0, torna - fee)),
    tornaStatus: (row.torna_status as TornaStatus) ?? 'none',
    status: row.status as BarterStatus,
    contractOfferedId: row.contract_offered_id,
    contractRequestedId: row.contract_requested_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function loadOr404(id: number): Promise<BarterRow> {
  const row = await barterRepository.findById(id);
  if (!row) throw new HttpError(404, 'Troca não encontrada', 'barter_not_found');
  return row;
}

const insufficient = (who: 'você' | 'o proponente', amount: number): HttpError =>
  new HttpError(
    402,
    who === 'você'
      ? `Saldo insuficiente para reservar a torna de ${brl(amount)}. Faça um depósito e tente de novo.`
      : `O proponente ainda não tem saldo para reservar a torna de ${brl(amount)}.`,
    'insufficient_balance',
  );

export const barterService = {
  /**
   * Proposta: calcula torna, pagador e taxa. Se quem paga a torna é o proponente, o valor é
   * reservado na carteira dele já aqui (402 sem saldo); se é o receptor, fica pendente até o aceite.
   */
  async propose(proposerId: number, input: CreateBarterInput): Promise<BarterAgreement> {
    if (!(await settingsService.barterEnabled())) {
      throw new HttpError(403, 'As trocas estão desativadas no momento', 'barter_disabled');
    }
    if (input.receiverId === proposerId) {
      throw new HttpError(400, 'Você não pode propor uma troca consigo mesmo', 'self_barter');
    }
    // Destinatário com a mesma regra da contratação direta: conta excluída, suspensa ou banida
    // não recebe proposta.
    if (!(await barterRepository.canReceiveProposal(input.receiverId))) {
      throw new HttpError(404, 'Usuário não encontrado', 'user_not_found');
    }
    // Serviço do catálogo: o oferecido é do proponente, o pedido é do receptor, nenhum removido e
    // nenhum pausado (RN-013, a mesma recusa da contratação: a troca gera contratações deles).
    let offeredService: CatalogService | null = null;
    let requestedService: CatalogService | null = null;
    if (input.offeredServiceId) {
      offeredService = await barterRepository.findCatalogService(input.offeredServiceId);
      if (offeredService?.userId !== proposerId) {
        throw new HttpError(
          422,
          'O serviço oferecido não existe, foi removido ou não é seu',
          'invalid_offered_service',
        );
      }
      if (!offeredService.isActive) {
        throw new HttpError(
          409,
          'O serviço oferecido está pausado: reative-o para propor a troca (RN-013).',
          'service_inactive',
        );
      }
    }
    if (input.requestedServiceId) {
      requestedService = await barterRepository.findCatalogService(input.requestedServiceId);
      if (requestedService?.userId !== input.receiverId) {
        throw new HttpError(
          422,
          'O serviço pedido não existe, foi removido ou não é de quem recebe a proposta',
          'invalid_requested_service',
        );
      }
      if (!requestedService.isActive) {
        throw new HttpError(
          409,
          'Este serviço está pausado e não aceita novas propostas (RN-013).',
          'service_inactive',
        );
      }
    }
    // RF-084: o sistema estima cada lado pelo catálogo; o valor digitado só vale sem preço fechado.
    const offeredSide = estimateSide('offered', offeredService, input.estimatedValueOffered);
    const requestedSide = estimateSide(
      'requested',
      requestedService,
      input.estimatedValueRequested,
    );
    const offered = offeredSide.value;
    const requested = requestedSide.value;

    // torna: a parte que recebe MAIS valor paga a diferença (RN-066)
    const cashDifference = money(Math.abs(offered - requested));
    let cashPayerId: number | null = null;
    if (offered > requested) cashPayerId = input.receiverId;
    else if (requested > offered) cashPayerId = proposerId;

    // Taxa vigente (platform_settings, ADR 32) só sobre a torna (RN-066): troca equilibrada não tem taxa.
    const platformFee = money((await settingsService.feeRate()) * cashDifference);
    const proposerPays = cashPayerId === proposerId && cashDifference > 0;
    const hold: TornaHold | null = proposerPays
      ? { userId: proposerId, amount: cashDifference }
      : null;

    const id = await barterRepository.create(
      {
        ulid: ulid(),
        proposerId,
        receiverId: input.receiverId,
        offeredServiceId: input.offeredServiceId ?? null,
        requestedServiceId: input.requestedServiceId ?? null,
        offeredDescription: input.offeredDescription ?? null,
        requestedDescription: input.requestedDescription ?? null,
        estimatedValueOffered: offered,
        estimatedValueRequested: requested,
        offeredValueSource: offeredSide.source,
        requestedValueSource: requestedSide.source,
        cashDifference,
        cashPayerId,
        platformFee,
        tornaStatus: cashDifference > 0 && !proposerPays ? 'pending' : 'none',
      },
      hold,
    );
    if (id === null) throw insufficient('você', cashDifference);

    return toBarter(await loadOr404(id));
  },

  async listMine(uid: number, input: ListBartersInput): Promise<Paginated<BarterAgreement>> {
    const rows = await barterRepository.listForUser(
      uid,
      input.limit,
      (input.page - 1) * input.limit,
    );
    return { items: rows.map(toBarter), page: input.page, limit: input.limit };
  },

  async getById(id: number, uid: number): Promise<BarterAgreement> {
    const row = await loadOr404(id);
    if (row.proposer_id !== uid && row.receiver_id !== uid) {
      throw new HttpError(403, 'Você não participa desta troca', 'forbidden');
    }
    return toBarter(row);
  },

  /**
   * Aceite bilateral (RN-067): gera os 2 contratos recíprocos e, se a torna ainda está
   * pendente (quem paga é o receptor, ou acordo antigo), reserva o valor na carteira do pagador.
   */
  async accept(id: number, uid: number): Promise<BarterAgreement> {
    const row = await loadOr404(id);
    if (row.receiver_id !== uid) {
      throw new HttpError(403, 'Apenas quem recebeu a proposta pode aceitar', 'forbidden');
    }
    if (row.status !== 'proposed') {
      throw new HttpError(409, `Troca não está mais disponível (${row.status})`, 'invalid_status');
    }

    const torna = Number(row.cash_difference);
    const hold: TornaHold | null =
      row.torna_status === 'pending' && row.cash_payer_id && torna > 0
        ? { userId: row.cash_payer_id, amount: torna }
        : null;

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
      hold,
      source: 'user',
    });
    if (!result.ok) {
      if (result.reason === 'insufficient_balance') {
        throw insufficient(hold?.userId === uid ? 'você' : 'o proponente', torna);
      }
      throw new HttpError(409, 'A troca mudou de estado; recarregue', 'conflict');
    }
    return toBarter(await loadOr404(id));
  },

  /** Recusa: a torna reservada (se houver) volta ao pagador na mesma transação. */
  async reject(id: number, uid: number): Promise<void> {
    const row = await loadOr404(id);
    if (row.receiver_id !== uid) {
      throw new HttpError(403, 'Apenas quem recebeu a proposta pode recusar', 'forbidden');
    }
    const ok = await barterRepository.setStatusFromProposed(id, 'rejected');
    if (!ok)
      throw new HttpError(409, `Troca não está mais disponível (${row.status})`, 'invalid_status');
  },

  async cancel(id: number, uid: number): Promise<void> {
    const row = await loadOr404(id);
    if (row.proposer_id !== uid && row.receiver_id !== uid) {
      throw new HttpError(403, 'Você não participa desta troca', 'forbidden');
    }
    const ok = await barterRepository.setStatusFromProposed(id, 'cancelled');
    if (!ok)
      throw new HttpError(409, `Só é possível cancelar uma troca ainda proposta`, 'invalid_status');
  },

  /**
   * Hook: um contrato da troca foi concluído — se AMBOS concluíram, fecha a troca e liquida a
   * torna (pagador deixa de ter o valor retido; o outro lado recebe torna − taxa).
   */
  async onLinkedContractCompleted(agreementId: number): Promise<void> {
    const row = await barterRepository.findById(agreementId);
    if (!row || row.status !== 'active') return;
    if (!row.contract_offered_id || !row.contract_requested_id) return;
    const [a, b] = await Promise.all([
      contractsFacade.findById(row.contract_offered_id),
      contractsFacade.findById(row.contract_requested_id),
    ]);
    if (a?.status !== 'completed' || b?.status !== 'completed') return;

    let done: boolean;
    try {
      done = await barterRepository.completeAndRelease(agreementId);
    } catch (err) {
      // Carteira recusou ou o banco falhou: a troca fica 'active' com a torna retida, e só
      // alguém olhando resolve. O contrato que disparou o gancho já foi concluído; não volta.
      logger.error({ err, barterId: agreementId }, 'troca: falha ao concluir e liquidar a torna');
      return;
    }
    if (!done) return;
    const torna = Number(row.cash_difference);
    const net = money(torna - Number(row.platform_fee));
    const receiverId = tornaReceiverOf(row);
    for (const uid of [row.proposer_id, row.receiver_id]) {
      const body =
        row.torna_status === 'held' && torna > 0
          ? uid === receiverId
            ? `Torna de ${brl(net)} creditada na sua carteira (taxa de ${brl(Number(row.platform_fee))}).`
            : `Torna de ${brl(torna)} paga ao outro lado.`
          : 'Os dois lados entregaram e aprovaram. Troca fechada.';
      void notificationsService.notify(uid, {
        type: 'barter_completed',
        title: 'Troca concluída',
        body,
        data: { barterId: agreementId },
      });
    }
    // Badges das duas partes (RF-065), depois do commit, como na conclusão do contrato: só a
    // chamada que concluiu a troca chega aqui, e uma falha não desfaz a troca nem os avisos.
    for (const uid of [row.proposer_id, row.receiver_id]) {
      try {
        await gamificationService.onBarterCompleted(uid);
      } catch (err) {
        logger.warn({ err, barterId: agreementId }, 'gamificação (onBarterCompleted) falhou');
      }
    }
  },

  /** Hook: um contrato da troca foi cancelado — a troca inteira entra em disputa (RN-067) e a torna volta. */
  async onLinkedContractCancelled(agreementId: number): Promise<void> {
    const row = await barterRepository.findById(agreementId);
    if (!row || row.status !== 'active') return;
    let done: boolean;
    try {
      done = await barterRepository.disputeAndRefund(agreementId);
    } catch (err) {
      // Mesma situação da conclusão: a troca segue 'active' com a torna presa no retido.
      logger.error(
        { err, barterId: agreementId },
        'troca: falha ao abrir disputa e devolver a torna',
      );
      return;
    }
    if (!done) return;
    const refunded = row.torna_status === 'held' && Number(row.cash_difference) > 0;
    for (const uid of [row.proposer_id, row.receiver_id]) {
      void notificationsService.notify(uid, {
        type: 'barter_disputed',
        title: 'Troca em disputa',
        body: refunded
          ? `Um dos contratos foi cancelado. A torna de ${brl(Number(row.cash_difference))} voltou para a carteira de quem pagou.`
          : 'Um dos contratos foi cancelado; o outro segue o próprio fluxo.',
        data: { barterId: agreementId },
      });
    }
  },
};
