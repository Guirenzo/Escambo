import type { Request, Response } from 'express';
import { gamificationService } from './gamification.service';

/** GET /api/gamification/me — XP, nível, progresso, streak, ranking e badges. */
export async function getMyGamification(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  res.json(
    await (user.status === 'suspended'
      ? gamificationService.getProfile(user.uid, { readOnly: true })
      : gamificationService.getProfile(user.uid)),
  );
}

/** GET /api/gamification/me/history — feed dos últimos ganhos de XP. */
export async function getMyHistory(req: Request, res: Response): Promise<void> {
  res.json(await gamificationService.getHistory(req.user!.uid));
}

/** GET /api/gamification/leaderboard — top por XP. */
export async function getLeaderboard(_req: Request, res: Response): Promise<void> {
  res.json(await gamificationService.getLeaderboard());
}
