import type { Request, Response } from 'express';
import { barterIdSchema, createBarterSchema, listBartersSchema } from './barter.schema';
import { barterService } from './barter.service';

export async function proposeBarter(req: Request, res: Response): Promise<void> {
  const input = createBarterSchema.parse(req.body);
  res.status(201).json(await barterService.propose(req.user!.uid, input));
}

export async function listBarters(req: Request, res: Response): Promise<void> {
  const query = listBartersSchema.parse(req.query);
  res.json(await barterService.listMine(req.user!.uid, query));
}

export async function getBarter(req: Request, res: Response): Promise<void> {
  const { id } = barterIdSchema.parse(req.params);
  res.json(await barterService.getById(id, req.user!.uid));
}

export async function acceptBarter(req: Request, res: Response): Promise<void> {
  const { id } = barterIdSchema.parse(req.params);
  res.json(await barterService.accept(id, req.user!.uid));
}

export async function rejectBarter(req: Request, res: Response): Promise<void> {
  const { id } = barterIdSchema.parse(req.params);
  await barterService.reject(id, req.user!.uid);
  res.status(204).send();
}

export async function cancelBarter(req: Request, res: Response): Promise<void> {
  const { id } = barterIdSchema.parse(req.params);
  await barterService.cancel(id, req.user!.uid);
  res.status(204).send();
}
