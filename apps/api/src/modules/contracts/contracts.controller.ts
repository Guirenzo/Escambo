import type { Request, Response } from 'express';
import {
  contractIdSchema,
  createContractSchema,
  deliverSchema,
  listContractsSchema,
  noteSchema,
} from './contracts.schema';
import { contractsService } from './contracts.service';

const uid = (req: Request): number => req.user!.uid;

export async function createContract(req: Request, res: Response): Promise<void> {
  const input = createContractSchema.parse(req.body);
  res.status(201).json(await contractsService.create(uid(req), input));
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
  res.json(await contractsService.accept(id, uid(req)));
}

export async function rejectContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  res.json(await contractsService.reject(id, uid(req)));
}

export async function deliverContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const input = deliverSchema.parse(req.body);
  res.json(await contractsService.deliver(id, uid(req), input));
}

export async function approveContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  res.json(await contractsService.approve(id, uid(req)));
}

export async function requestRevisionContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  const { note } = noteSchema.parse(req.body);
  res.json(await contractsService.requestRevision(id, uid(req), note ?? null));
}

export async function cancelContract(req: Request, res: Response): Promise<void> {
  const { id } = contractIdSchema.parse(req.params);
  res.json(await contractsService.cancel(id, uid(req)));
}
