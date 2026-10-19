import type { Request, Response } from 'express';
import { optionalUserId } from '../../middlewares/authenticate';
import {
  createServiceSchema,
  listServicesSchema,
  serviceIdSchema,
  updateServiceSchema,
} from './services.schema';
import { servicesService } from './services.service';

export async function createService(req: Request, res: Response): Promise<void> {
  const input = createServiceSchema.parse(req.body);
  const service = await servicesService.create(req.user!.uid, input);
  res.status(201).json(service);
}

export async function listServices(req: Request, res: Response): Promise<void> {
  const query = listServicesSchema.parse(req.query);
  res.json(await servicesService.list(query));
}

export async function listMyServices(req: Request, res: Response): Promise<void> {
  res.json(await servicesService.listMine(req.user!.uid));
}

export async function getService(req: Request, res: Response): Promise<void> {
  const { id } = serviceIdSchema.parse(req.params);
  // Rota pública: o token, se veio, só diz se quem abre é o dono (que não conta visualização).
  res.json(await servicesService.getById(id, { userId: optionalUserId(req), ip: req.ip }));
}

export async function updateService(req: Request, res: Response): Promise<void> {
  const { id } = serviceIdSchema.parse(req.params);
  const input = updateServiceSchema.parse(req.body);
  res.json(await servicesService.update(id, req.user!.uid, input));
}

export async function deleteService(req: Request, res: Response): Promise<void> {
  const { id } = serviceIdSchema.parse(req.params);
  await servicesService.remove(id, req.user!.uid);
  res.status(204).send();
}
