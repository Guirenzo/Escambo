import type { Express } from 'express';
import request from 'supertest';

/**
 * As notificações são gravadas em "melhor esforço" (fire-and-forget) depois da resposta HTTP.
 * Checar a lista logo após a ação é uma corrida — sob carga (CI) perde. Espera até aparecer.
 */
export async function waitForNotification(
  app: Express,
  token: string,
  type: string,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app)
      .get('/api/notifications')
      .set({ Authorization: `Bearer ${token}` });
    const items = (res.body?.items ?? []) as { type: string }[];
    if (items.some((n) => n.type === type)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}
