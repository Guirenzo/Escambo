/**
 * Controller das contratações (camada de controller).
 * Pra que serve: recebe a requisição já autenticada, valida a URL e o corpo com os schemas do
 * zod (contracts.schema.ts), chama o service e devolve o JSON com o status HTTP certo.
 * Com quem conversa: é chamado pelas rotas (contracts.routes.ts) e chama o contractsService;
 * para avisos e auditoria usa os services desses módulos. Não fala com o banco.
 * Se o parse do zod falhar, o error-handler responde 422 com os campos errados.
 * Autorização (P9): o id de quem pede vem sempre do token (req.user.uid), nunca do corpo.
 * O que tem dentro: uma função por rota (criar, listar, ver, negociar, aceitar, recusar,
 * entregar, aprovar, revisões, prazo, marcos e cancelar) e os ajudantes uid, uploads e audit.
 */
import type { Request, Response } from 'express';
import { auditService } from '../audit/audit.service';
import { notificationsService } from '../notifications/notifications.service';
import {
  cancelBodySchema,
  contractIdSchema,
  counterOfferSchema,
  createContractSchema,
  deliverFormSchema,
  deliverMilestoneSchema,
  deliverSchema,
  grantRevisionBodySchema,
  listContractsSchema,
  extensionDecisionBodySchema,
  extensionDecisionSchema,
  extensionSchema,
  milestoneParamsSchema,
  noteSchema,
  offerAcceptParamsSchema,
  offerDecisionBodySchema,
} from './contracts.schema';
import { contractsService } from './contracts.service';

/** O id de quem está logado, posto em req.user pelo authenticate (P9). */
const uid = (req: Request): number => req.user!.uid;

/** Arquivos da entrega em multipart (campo attachments, RF-035); no corpo JSON, nenhum. */
const uploads = (req: Request): Express.Multer.File[] =>
  Array.isArray(req.files) ? req.files : [];
/** IP e navegador de quem pediu, que vão junto em cada linha da auditoria. */
const audit = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.headers['user-agent'] ?? null,
});

/**
 * POST /contracts: valida o corpo e cria a proposta (em dinheiro, o valor já fica reservado
 * na carteira do cliente). Responde 201 com a contratação em `pending`.
 */
export async function createContract(req: Request, res: Response): Promise<void> {
  const input = createContractSchema.parse(req.body);
  const contract = await contractsService.create(uid(req), input);
  res.status(201).json(contract);
}

/** GET /contracts: as contratações de quem está logado, paginadas e com filtro (RF-040). */
export async function listContracts(req: Request, res: Response): Promise<void> {
  const query = listContractsSchema.parse(req.query);
  res.json(await contractsService.listMine(uid(req), query));
}

/** GET /contracts/:id: o detalhe com histórico; quem não é parte recebe 403 do service. */
export async function getContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  res.json(await contractsService.getById(id, uid(req)));
}

/** POST /:id/accept: o freelancer aceita a proposta e o escrow se forma (RF-032). */
export async function acceptContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const { seq } = offerDecisionBodySchema.parse(req.body ?? {});
  const contract = await contractsService.accept(id, uid(req), seq);
  // O aceite de uma contraproposta (oferta 2 em diante) também vai para a auditoria.
  if (seq !== undefined && seq > 1) {
    void auditService.log({
      userId: uid(req),
      action: 'contract_offer_accepted',
      entityType: 'contract',
      entityId: id,
      newValue: { seq },
      ...audit(req),
    });
  }
  res.json(contract);
}

/** POST /:id/reject: o freelancer recusa; a reserva volta inteira ao cliente. */
export async function rejectContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const { seq } = offerDecisionBodySchema.parse(req.body ?? {});
  const contract = await contractsService.reject(id, uid(req), seq);
  res.json(contract);
}

/** POST /:id/offers: a contraproposta de quem tem a vez (RN-030). Responde 201. */
export async function counterOffer(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const input = counterOfferSchema.parse(req.body);
  const contract = await contractsService.counter(id, uid(req), input);
  // void: grava a auditoria sem a resposta esperar por ela.
  void auditService.log({
    userId: uid(req),
    action: 'contract_offer_sent',
    entityType: 'contract',
    entityId: id,
    newValue: { seq: input.seq + 1, price: input.price, deadlineAt: input.deadlineAt },
    ...audit(req),
  });
  res.status(201).json(contract);
}

/** POST /:id/offers/:seq/accept: o cliente aceita a oferta do freelancer (RN-030). */
export async function acceptCounterOffer(req: Request, res: Response): Promise<void> {
  const { id, seq } = offerAcceptParamsSchema.parse(req.params);
  const contract = await contractsService.acceptCounter(id, uid(req), seq);
  void auditService.log({
    userId: uid(req),
    action: 'contract_offer_accepted',
    entityType: 'contract',
    entityId: id,
    newValue: { seq },
    ...audit(req),
  });
  res.json(contract);
}

/** POST /:id/deliver: o freelancer entrega, em JSON ou em multipart com arquivos (RF-035). */
export async function deliverContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  // Com arquivos, a entrega vem em multipart: os links chegam como texto (RF-035).
  const input = (req.is('multipart/form-data') ? deliverFormSchema : deliverSchema).parse(
    req.body ?? {},
  );
  // O aviso ao cliente sai do service, com a hora da aprovação automática (ADR 57).
  res.json(await contractsService.deliver(id, uid(req), input, uploads(req)));
}

/**
 * POST /:id/approve: o cliente aprova a entrega e o service libera o escrow (RN-033): o
 * líquido sai do saldo retido do freelancer e vai para o disponível dele.
 */
export async function approveContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const contract = await contractsService.approve(id, uid(req));
  // O dinheiro já foi liberado: o aviso e a auditoria saem depois, sem segurar a resposta.
  void notificationsService.notify(contract.freelancerId, {
    type: 'contract_completed',
    title: 'Contratação concluída — pagamento liberado',
    data: { contractId: contract.id },
  });
  void auditService.log({
    userId: uid(req),
    action: 'contract_completed',
    entityType: 'contract',
    entityId: contract.id,
    newValue: { freelancerNet: contract.freelancerNet },
    ...audit(req),
  });
  res.json(contract);
}

/** POST /:id/request-revision: o cliente pede ajuste na entrega (RN-023). */
export async function requestRevisionContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const { note } = noteSchema.parse(req.body);
  res.json(await contractsService.requestRevision(id, uid(req), note ?? null));
}

/** POST /:id/revisions/grant: o freelancer libera mais uma revisão sem custo (RN-023). */
export async function grantRevisionContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  grantRevisionBodySchema.parse(req.body);
  const contract = await contractsService.grantRevision(id, uid(req));
  void auditService.log({
    userId: uid(req),
    action: 'revision_granted',
    entityType: 'contract',
    entityId: id,
    newValue: { limit: contract.revisions?.limit },
    ...audit(req),
  });
  res.json(contract);
}

// ---------- Prazos (RN-028) ----------

/** POST /:id/extension: o freelancer pede um prazo novo, com motivo (RN-028). */
export async function requestExtension(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const input = extensionSchema.parse(req.body);
  // O aviso ao cliente sai do service, com a hora para responder (ADR 57).
  res.json(await contractsService.requestExtension(id, uid(req), input));
}

/** POST /:id/extension/accept ou /decline: o cliente decide o pedido de prazo. */
export async function resolveExtension(req: Request, res: Response): Promise<void> {
  const { id, decision } = extensionDecisionSchema.parse(req.params);
  const { seq } = extensionDecisionBodySchema.parse(req.body ?? {});
  // Aceite e recusa avisam quem entrega pelo service (a recusa diz até quando agir, ADR 57).
  res.json(
    await contractsService.resolveExtension(id, uid(req), decision === 'accept', seq ?? null),
  );
}

// ---------- Escrow por marcos (RN-069) ----------

/** POST /:id/milestones/:milestoneId/deliver: o freelancer entrega um marco (RN-069). */
export async function deliverMilestone(req: Request, res: Response): Promise<void> {
  const { id, milestoneId } = milestoneParamsSchema.parse(req.params);
  const input = deliverMilestoneSchema.parse(req.body ?? {});
  // O aviso ao cliente sai do service, com a hora da aprovação automática do marco (ADR 57).
  res.json(
    await contractsService.deliverMilestone(id, milestoneId, uid(req), input.message, uploads(req)),
  );
}

/**
 * POST /:id/milestones/:milestoneId/approve: o cliente aprova um marco e libera só o líquido
 * dele; o último marco aprovado conclui a contratação (RN-069).
 */
export async function approveMilestone(req: Request, res: Response): Promise<void> {
  const { id, milestoneId } = milestoneParamsSchema.parse(req.params);
  const r = await contractsService.approveMilestone(id, milestoneId, uid(req));
  void notificationsService.notify(r.contract.freelancerId, {
    type: r.completed ? 'contract_completed' : 'milestone_approved',
    title: r.completed
      ? 'Contratação concluída — último marco liberado'
      : `Marco aprovado: ${r.title}`,
    body:
      r.unit === 'credits'
        ? `${r.net} créditos liberados na sua carteira.`
        : `${r.net.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} liberados na sua carteira.`,
    data: { contractId: r.contract.id, milestoneId },
  });
  void auditService.log({
    userId: uid(req),
    action: r.completed ? 'contract_completed' : 'milestone_approved',
    entityType: 'contract',
    entityId: r.contract.id,
    newValue: { milestoneId, net: r.net },
    ...audit(req),
  });
  res.json(r.contract);
}

/** POST /:id/milestones/:milestoneId/request-revision: revisão de um marco (RN-023). */
export async function requestMilestoneRevision(req: Request, res: Response): Promise<void> {
  const { id, milestoneId } = milestoneParamsSchema.parse(req.params);
  const { note } = noteSchema.parse(req.body);
  const contract = await contractsService.requestMilestoneRevision(
    id,
    milestoneId,
    uid(req),
    note ?? null,
  );
  // O service avisa após confirmar a revisão, com o uso/limite da unidade (RN-023).
  res.json(contract);
}

/** POST /:id/milestones/:milestoneId/revisions/grant: mais uma revisão no marco. */
export async function grantMilestoneRevision(req: Request, res: Response): Promise<void> {
  const { id, milestoneId } = milestoneParamsSchema.parse(req.params);
  grantRevisionBodySchema.parse(req.body);
  const contract = await contractsService.grantMilestoneRevision(id, milestoneId, uid(req));
  void auditService.log({
    userId: uid(req),
    action: 'revision_granted',
    entityType: 'contract',
    entityId: id,
    newValue: { milestoneId },
    ...audit(req),
  });
  res.json(contract);
}

/**
 * POST /:id/cancel: o cliente cancela ou o freelancer desiste. Quanto volta a cada um vem
 * do service (RN-025); a auditoria guarda a etapa, o percentual e os valores.
 */
export async function cancelContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const body = cancelBodySchema.parse(req.body ?? {});
  const result = await contractsService.cancel(id, uid(req), body);
  void auditService.log({
    userId: uid(req),
    action: 'contract_cancelled',
    entityType: 'contract',
    entityId: id,
    newValue: {
      by: result.by,
      stage: result.stage,
      refundPercentage: result.refundPercentage,
      refundClient: result.refundClient,
      releaseFreelancer: result.releaseFreelancer,
    },
    ...audit(req),
  });
  res.json(result);
}
