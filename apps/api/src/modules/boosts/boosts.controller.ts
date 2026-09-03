import type { Request, Response } from 'express';
import { createBoostSchema } from './boosts.schema';
import { boostsService } from './boosts.service';

/** GET /api/boosts/plans — planos de impulsionamento disponíveis. */
export async function listPlans(_req: Request, res: Response): Promise<void> {
  res.json(await boostsService.plans());
}

/** POST /api/boosts — impulsiona um serviço (paga em créditos Escambo). */
export async function createBoost(req: Request, res: Response): Promise<void> {
  const { serviceId, planId } = createBoostSchema.parse(req.body);
  const boost = await boostsService.buy(req.user!.uid, serviceId, planId);
  res.status(201).json(boost);
}

/** GET /api/boosts — meus impulsionamentos. */
export async function listMyBoosts(req: Request, res: Response): Promise<void> {
  res.json(await boostsService.listMine(req.user!.uid));
}
