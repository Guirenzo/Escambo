import type { ContractWithHistory, Milestone, Wallet, WalletTransaction } from '@escambo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { settingsRepository } from '../../src/modules/settings/settings.repository';
import { settingsService } from '../../src/modules/settings/settings.service';
import { startDaytimeClock, stopClock } from './clock.helpers';
import { fundWallet } from './wallet.helpers';

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const cents = (amount: number): number => Math.round(amount * 100);

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function actor(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `milestone_cents_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

async function wallet(token: string): Promise<Wallet> {
  const res = await request(app).get('/api/wallet').set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Wallet;
}

async function detail(id: number, token: string): Promise<ContractWithHistory> {
  const res = await request(app).get(`/api/contracts/${id}`).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ContractWithHistory;
}

/** Confere o contrato financeiro, sem reproduzir a distribuição usada pelo rateio. */
function expectAllocation(milestones: Milestone[]): void {
  expect(milestones).toHaveLength(10);
  let amount = 0;
  let net = 0;
  let fee = 0;
  for (const milestone of milestones) {
    expect(milestone.freelancerNet, milestone.title).toBeGreaterThanOrEqual(0);
    expect(milestone.freelancerNet, milestone.title).toBeLessThanOrEqual(milestone.amount);
    expect(cents(milestone.freelancerNet) / 100, milestone.title).toBe(milestone.freelancerNet);
    const feeCents = cents(milestone.amount) - cents(milestone.freelancerNet);
    expect(feeCents, `taxa de ${milestone.title}`).toBeGreaterThanOrEqual(0);
    amount += cents(milestone.amount);
    net += cents(milestone.freelancerNet);
    fee += feeCents;
  }
  expect({ amount, net, fee }).toEqual({ amount: 1000, net: 500, fee: 500 });
}

beforeAll(() => {
  startDaytimeClock();
});

afterAll(async () => {
  stopClock();
  await pool.end();
});

describe('Marcos assimétricos e conservação de centavos (RN-069)', () => {
  it('R$ 9,91 + nove marcos de R$ 0,01 com taxa 50% libera dez marcos sem líquido ou taxa negativos', async () => {
    const client = await actor('client');
    const freelancer = await actor('freelancer');
    await fundWallet(app, client.token, 10);
    expect(await wallet(freelancer.token)).toMatchObject({ balance: 0, balancePending: 0 });

    const previousFee = await settingsRepository.get('platform_fee_percentage');
    expect(previousFee, 'o seed disponibiliza a taxa que será restaurada').not.toBeNull();
    try {
      await settingsRepository.set('platform_fee_percentage', '50', 'integer');
      settingsService.clearCache();
      const amounts = [9.91, ...Array<number>(9).fill(0.01)];
      const created = await request(app)
        .post('/api/contracts')
        .set(auth(client.token))
        .send({
          freelancerId: freelancer.id,
          title: 'Dez marcos com centavos',
          description: 'Rateio de comissão em um marco grande e nove marcos de um centavo',
          price: 10,
          milestones: amounts.map((amount, index) => ({ title: `Etapa ${index + 1}`, amount })),
        });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({
        price: 10,
        platformFee: 5,
        freelancerNet: 5,
        hasMilestones: true,
      });
      const id = created.body.id as number;
      const proposal = await detail(id, client.token);
      expect(proposal.milestones.map((m) => m.amount)).toEqual(amounts);
      expect(proposal.milestones.every((m) => m.status === 'pending')).toBe(true);
      expectAllocation(proposal.milestones);

      const accepted = await request(app)
        .post(`/api/contracts/${id}/accept`)
        .set(auth(freelancer.token));
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(await wallet(client.token)).toMatchObject({ balance: 0, balancePending: 0 });
      expect(await wallet(freelancer.token)).toMatchObject({ balance: 0, balancePending: 5 });
      const funded = await detail(id, freelancer.token);
      expect(funded.milestones.every((m) => m.status === 'funded')).toBe(true);
      expect(funded.milestones.map((m) => m.freelancerNet)).toEqual(
        proposal.milestones.map((m) => m.freelancerNet),
      );
      expectAllocation(funded.milestones);

      let released = 0;
      for (const [index, milestone] of funded.milestones.entries()) {
        const delivered = await request(app)
          .post(`/api/contracts/${id}/milestones/${milestone.id}/deliver`)
          .set(auth(freelancer.token))
          .send({ message: `Entrega fictícia da etapa ${index + 1}` });
        expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
        const approved = await request(app)
          .post(`/api/contracts/${id}/milestones/${milestone.id}/approve`)
          .set(auth(client.token));
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        expect(approved.body.status).toBe(index === 9 ? 'completed' : 'in_progress');
        expect(approved.body.milestones[index].status).toBe('released');
        released += cents(milestone.freelancerNet);
        // Nenhuma aprovação pode debitar disponível ou exigir escrow além dos R$ 5,00 retidos.
        expect(await wallet(freelancer.token)).toMatchObject({
          balance: released / 100,
          balancePending: (500 - released) / 100,
        });
      }

      const completed = await detail(id, client.token);
      expect(completed).toMatchObject({ status: 'completed', platformFee: 5, freelancerNet: 5 });
      expect(completed.milestones.every((m) => m.status === 'released')).toBe(true);
      expectAllocation(completed.milestones);
      expect(await wallet(freelancer.token)).toMatchObject({ balance: 5, balancePending: 0 });
      expect(await wallet(client.token)).toMatchObject({ balance: 0, balancePending: 0 });

      const statement = await request(app)
        .get('/api/wallet/transactions?limit=100')
        .set(auth(freelancer.token));
      expect(statement.status, JSON.stringify(statement.body)).toBe(200);
      const transactions = (statement.body.items as WalletTransaction[])
        .filter((tx) => tx.contractId === id)
        .sort((a, b) => a.id - b.id);
      const releases = transactions.filter((tx) => tx.reason === 'escrow_release');
      expect(releases).toHaveLength(10);
      expect(releases.map((tx) => cents(tx.amount))).toEqual(
        funded.milestones.map((m) => cents(m.freelancerNet)),
      );
      expect(releases.reduce((sum, tx) => sum + cents(tx.amount), 0)).toBe(500);
      expect(releases.reduce((sum, tx) => sum + cents(tx.pendingDelta), 0)).toBe(-500);
      expect(transactions.reduce((sum, tx) => sum + cents(tx.pendingDelta), 0)).toBe(0);
      let previousBalance = 0;
      for (const tx of transactions) {
        expect(tx.amount).toBeGreaterThanOrEqual(0);
        expect(tx.balanceAfter).toBeGreaterThanOrEqual(previousBalance);
        expect(tx.pendingAfter).toBeGreaterThanOrEqual(0);
        previousBalance = tx.balanceAfter;
      }
      expect(transactions.at(-1)).toMatchObject({ balanceAfter: 5, pendingAfter: 0 });
    } finally {
      await settingsRepository.set('platform_fee_percentage', previousFee!, 'integer');
      settingsService.clearCache();
    }
  });
});
