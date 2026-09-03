import type { Request, Response } from 'express';
import { createSavedSearchSchema, savedSearchIdSchema } from './saved-searches.schema';
import { savedSearchesService } from './saved-searches.service';

export async function createSavedSearch(req: Request, res: Response): Promise<void> {
  const input = createSavedSearchSchema.parse(req.body);
  res.status(201).json(await savedSearchesService.create(req.user!.uid, input));
}

export async function listSavedSearches(req: Request, res: Response): Promise<void> {
  res.json(await savedSearchesService.list(req.user!.uid));
}

export async function removeSavedSearch(req: Request, res: Response): Promise<void> {
  const { id } = savedSearchIdSchema.parse(req.params);
  await savedSearchesService.remove(id, req.user!.uid);
  res.status(204).send();
}
