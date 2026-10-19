import type { Request, Response } from 'express';
import {
  adminReplySupportSchema,
  closeSupportSchema,
  createSupportSchema,
  replySupportSchema,
  supportDetailSchema,
  supportIdSchema,
  supportListSchema,
  updateSupportSchema,
} from './support.schema';
import { supportService } from './support.service';

export const supportController = {
  async list(req: Request, res: Response): Promise<void> {
    res.json(await supportService.list(req.user!.uid, supportListSchema.parse(req.query)));
  },
  async adminList(req: Request, res: Response): Promise<void> {
    res.json(await supportService.list(null, supportListSchema.parse(req.query)));
  },
  async detail(req: Request, res: Response): Promise<void> {
    const { id } = supportIdSchema.parse(req.params);
    const { beforeId } = supportDetailSchema.parse(req.query);
    res.json(await supportService.detail(id, req.user!.uid, beforeId));
  },
  async adminDetail(req: Request, res: Response): Promise<void> {
    const { id } = supportIdSchema.parse(req.params);
    const { beforeId } = supportDetailSchema.parse(req.query);
    res.json(await supportService.detail(id, null, beforeId));
  },
  async create(req: Request, res: Response): Promise<void> {
    res
      .status(201)
      .json(await supportService.create(req.user!.uid, createSupportSchema.parse(req.body)));
  },
  async reply(req: Request, res: Response): Promise<void> {
    const { id } = supportIdSchema.parse(req.params);
    res
      .status(201)
      .json(
        await supportService.reply(id, req.user!.uid, false, replySupportSchema.parse(req.body)),
      );
  },
  async adminReply(req: Request, res: Response): Promise<void> {
    const { id } = supportIdSchema.parse(req.params);
    res
      .status(201)
      .json(
        await supportService.reply(
          id,
          req.user!.uid,
          true,
          adminReplySupportSchema.parse(req.body),
        ),
      );
  },
  async close(req: Request, res: Response): Promise<void> {
    const { id } = supportIdSchema.parse(req.params);
    closeSupportSchema.parse(req.body);
    res.json(await supportService.close(id, req.user!.uid));
  },
  async update(req: Request, res: Response): Promise<void> {
    const { id } = supportIdSchema.parse(req.params);
    res.json(await supportService.update(id, req.user!.uid, updateSupportSchema.parse(req.body)));
  },
};
