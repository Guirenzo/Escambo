import type { Request, Response } from 'express';
import { auditService } from '../audit/audit.service';
import { notificationsService } from '../notifications/notifications.service';
import {
  contractIdSchema,
  createContractSchema,
  deliverSchema,
  listContractsSchema,
  extensionDecisionSchema,
  extensionSchema,
  milestoneParamsSchema,
  noteSchema,
} from './contracts.schema';
import { brDate, contractsService } from './contracts.service';

const uid = (req: Request): number => req.user!.uid;
const audit = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.headers['user-agent'] ?? null,
});

export async function createContract(req: Request, res: Response): Promise<void> {
  const input = createContractSchema.parse(req.body);
  const contract = await contractsService.create(uid(req), input);
  void notificationsService.notify(contract.freelancerId, {
    type: 'contract_proposal',
    title: 'Nova proposta de contratação',
    body: contract.title,
    data: { contractId: contract.id },
  });
  res.status(201).json(contract);
}

export async function listContracts(req: Request, res: Response): Promise<void> {
  const query = listContractsSchema.parse(req.query);
  res.json(await contractsService.listMine(uid(req), query));
}

export async function getContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  res.json(await contractsService.getById(id, uid(req)));
}

export async function acceptContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const contract = await contractsService.accept(id, uid(req));
  void notificationsService.notify(contract.clientId, {
    type: 'contract_accepted',
    title: 'Sua proposta foi aceita',
    data: { contractId: contract.id },
  });
  res.json(contract);
}

export async function rejectContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const contract = await contractsService.reject(id, uid(req));
  void notificationsService.notify(contract.clientId, {
    type: 'contract_rejected',
    title: 'Sua proposta foi recusada',
    data: { contractId: contract.id },
  });
  res.json(contract);
}

export async function deliverContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const input = deliverSchema.parse(req.body);
  const contract = await contractsService.deliver(id, uid(req), input);
  void notificationsService.notify(contract.clientId, {
    type: 'contract_delivered',
    title: 'A entrega foi registrada',
    data: { contractId: contract.id },
  });
  res.json(contract);
}

export async function approveContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const contract = await contractsService.approve(id, uid(req));
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

export async function requestRevisionContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const { note } = noteSchema.parse(req.body);
  const contract = await contractsService.requestRevision(id, uid(req), note ?? null);
  void notificationsService.notify(contract.freelancerId, {
    type: 'contract_revision',
    title: 'Revisão solicitada',
    data: { contractId: contract.id },
  });
  res.json(contract);
}

// ---------- Prazos (RN-028) ----------

export async function requestExtension(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const input = extensionSchema.parse(req.body);
  const contract = await contractsService.requestExtension(id, uid(req), input);
  void notificationsService.notify(contract.clientId, {
    type: 'deadline_extension_requested',
    title: 'Pedido de extensão de prazo',
    body: `${contract.title}: novo prazo proposto ${brDate(input.deadlineAt)} — ${input.reason}`,
    data: { contractId: contract.id },
  });
  res.json(contract);
}

export async function resolveExtension(req: Request, res: Response): Promise<void> {
  const { id, decision } = extensionDecisionSchema.parse(req.params);
  const accept = decision === 'accept';
  const contract = await contractsService.resolveExtension(id, uid(req), accept);
  void notificationsService.notify(contract.freelancerId, {
    type: accept ? 'deadline_extension_accepted' : 'deadline_extension_declined',
    title: accept
      ? `Extensão aceita: novo prazo ${contract.deadlineAt ? brDate(contract.deadlineAt) : ''}`
      : 'Extensão de prazo recusada',
    body: accept
      ? `${contract.title}: o prazo foi estendido (única extensão da contratação).`
      : `${contract.title}: o prazo original continua valendo.`,
    data: { contractId: contract.id },
  });
  res.json(contract);
}

// ---------- Escrow por marcos (RN-069) ----------

export async function deliverMilestone(req: Request, res: Response): Promise<void> {
  const { id, milestoneId } = milestoneParamsSchema.parse(req.params);
  const input = deliverSchema.parse(req.body);
  const contract = await contractsService.deliverMilestone(
    id,
    milestoneId,
    uid(req),
    input.message,
  );
  const m = contract.milestones.find((x) => x.id === milestoneId);
  void notificationsService.notify(contract.clientId, {
    type: 'milestone_delivered',
    title: `Marco entregue: ${m?.title ?? 'marco'}`,
    body: input.message,
    data: { contractId: contract.id, milestoneId },
  });
  res.json(contract);
}

export async function approveMilestone(req: Request, res: Response): Promise<void> {
  const { id, milestoneId } = milestoneParamsSchema.parse(req.params);
  const r = await contractsService.approveMilestone(id, milestoneId, uid(req));
  void notificationsService.notify(r.contract.freelancerId, {
    type: r.completed ? 'contract_completed' : 'milestone_approved',
    title: r.completed
      ? 'Contratação concluída — último marco liberado'
      : `Marco aprovado: ${r.title}`,
    body: `${r.net.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} liberados na sua carteira.`,
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

export async function requestMilestoneRevision(req: Request, res: Response): Promise<void> {
  const { id, milestoneId } = milestoneParamsSchema.parse(req.params);
  const { note } = noteSchema.parse(req.body);
  const contract = await contractsService.requestMilestoneRevision(
    id,
    milestoneId,
    uid(req),
    note ?? null,
  );
  void notificationsService.notify(contract.freelancerId, {
    type: 'milestone_revision',
    title: 'Revisão solicitada em um marco',
    body: note ?? null,
    data: { contractId: contract.id, milestoneId },
  });
  res.json(contract);
}

export async function cancelContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const result = await contractsService.cancel(id, uid(req));
  void auditService.log({
    userId: uid(req),
    action: 'contract_cancelled',
    entityType: 'contract',
    entityId: id,
    newValue: { refundPercentage: result.refundPercentage },
    ...audit(req),
  });
  res.json(result);
}
