import type { Request, Response } from 'express';
import { ulidParamSchema, upsertClientSchema, upsertFreelancerSchema } from './profiles.schema';
import { profilesService } from './profiles.service';

export async function getMyProfiles(req: Request, res: Response): Promise<void> {
  res.json(await profilesService.getMine(req.user!.uid));
}

export async function putFreelancerProfile(req: Request, res: Response): Promise<void> {
  const input = upsertFreelancerSchema.parse(req.body);
  res.json(await profilesService.upsertFreelancer(req.user!.uid, input));
}

export async function putClientProfile(req: Request, res: Response): Promise<void> {
  const input = upsertClientSchema.parse(req.body);
  res.json(await profilesService.upsertClient(req.user!.uid, input));
}

export async function getPublicFreelancer(req: Request, res: Response): Promise<void> {
  const { ulid } = ulidParamSchema.parse(req.params);
  res.json(await profilesService.getPublicFreelancer(ulid));
}
