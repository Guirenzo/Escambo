import type { Request, Response } from 'express';
import { leaderboardQuerySchema } from './gamification.schema';
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

/**
 * GET /api/gamification/me/missions — missões do período vigente com o progresso (RF-066, RN-054).
 * Abrir conta como o acesso do dia; conta sem perfil de freelancer, suspensa ou banida recebe [].
 */
export async function getMyMissions(req: Request, res: Response): Promise<void> {
  res.json(await gamificationService.listMissions(req.user!.uid));
}

/** GET /api/gamification/leaderboard — geral por XP; com categoria e/ou lat+lng, RN-056. */
export async function getLeaderboard(req: Request, res: Response): Promise<void> {
  const query = leaderboardQuerySchema.parse(req.query);
  res.json(
    await gamificationService.getLeaderboard({
      ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
      ...(query.lat !== undefined && query.lng !== undefined
        ? { lat: query.lat, lng: query.lng }
        : {}),
    }),
  );
}
