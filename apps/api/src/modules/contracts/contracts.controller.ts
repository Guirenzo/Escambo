import type { Request, Response } from 'express';
import { auditService } from '../audit/audit.service';
import { notificationsService } from '../notifications/notifications.service';
import {
  contractIdSchema,
  createContractSchema,
  deliverSchema,
  listContractsSchema,
  noteSchema,
} from './contracts.schema';
import { contractsService } from './contracts.service';

const uid = (req: Request): number => req.user!.uid;
const audit = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });

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
