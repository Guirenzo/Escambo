import type { ResultSetHeader } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/config/db';
import { contractsRepository } from '../../src/modules/contracts/contracts.repository';
import { contractsService } from '../../src/modules/contracts/contracts.service';
import { milestonesRepository } from '../../src/modules/contracts/milestones.repository';

let clientId: number;
let freelancerId: number;
let seq = 0;

beforeAll(async () => {
  for (const role of ['client', 'freelancer']) {
    const key = `rule-read-${role}-${Date.now()}`;
    const [row] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (ulid, email, role, status) VALUES (:ulid, :email, :role, 'active')`,
      { ulid: key.slice(-26), email: `${key}@escambo.test`, role },
    );
    if (role === 'client') clientId = row.insertId;
    else freelancerId = row.insertId;
  }
});

afterAll(async () => {
  try {
    await pool.query(
      'DELETE FROM contracts WHERE client_id = :clientId AND freelancer_id = :freelancerId',
      { clientId, freelancerId },
    );
    await pool.query('DELETE FROM users WHERE id IN (:clientId, :freelancerId)', {
      clientId,
      freelancerId,
    });
  } finally {
    await pool.end();
  }
});

async function contract(): Promise<number> {
  const [row] = await pool.query<ResultSetHeader>(
    `INSERT INTO contracts
       (ulid, client_id, freelancer_id, title, description, price, platform_fee,
        freelancer_net, status, created_at)
     VALUES (:ulid, :clientId, :freelancerId, 'Leitura ADR 61', 'Termos legados',
             100, 15, 85, 'in_progress', '2026-10-01 12:00:00')`,
    { ulid: `read-${Date.now()}-${seq++}`, clientId, freelancerId },
  );
  return row.insertId;
}

async function milestone(
  contractId: number,
  status: string,
  deliveredAt: Date | null,
  approvalDueAt: Date | null,
  disputeOpensAt: Date | null,
): Promise<number> {
  const [row] = await pool.query<ResultSetHeader>(
    `INSERT INTO contract_milestones
       (contract_id, title, amount, freelancer_net, sort_order, status, delivered_at,
        approval_due_at, dispute_opens_at)
     VALUES (:contractId, :title, 20, 17, :sortOrder, :status, :deliveredAt,
             :approvalDueAt, :disputeOpensAt)`,
    {
      contractId,
      title: `Marco ${seq}`,
      sortOrder: seq++,
      status,
      deliveredAt,
      approvalDueAt,
      disputeOpensAt,
    },
  );
  return row.insertId;
}

const at = (day: number): Date => new Date(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`);

async function delivery(contractId: number, createdAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO deliveries (contract_id, message, delivered_at, created_at)
     VALUES (:contractId, 'Entrega histórica', :createdAt, :createdAt)`,
    { contractId, createdAt },
  );
}

async function history(
  contractId: number,
  newStatus: string,
  note: string,
  createdAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO contract_status_history
       (contract_id, changed_by, old_status, new_status, note, created_at)
     VALUES (:contractId, :clientId, 'in_progress', :newStatus, :note, :createdAt)`,
    { contractId, clientId, newStatus, note, createdAt },
  );
}

describe('Leitura das regras persistidas (ADR 61)', () => {
  it('lê o snapshot como Date UTC e publica o mesmo instante na Sala, sem reabrir o histórico', async () => {
    const id = await contract();
    await delivery(id, at(2));
    await pool.query(
      `UPDATE contracts SET status = 'delivered', first_delivery_at = :first,
                            approval_due_at = :approval WHERE id = :id`,
      { id, first: at(4), approval: at(12) },
    );

    const read = (await contractsRepository.findById(id))!;
    // COALESCE/LEAST sem o CAST final pode virar string no mysql2; new Date(string)
    // interpretaria a hora no fuso do processo, deslocando a janela do contrato.
    expect(read.first_delivered_at).toBeInstanceOf(Date);
    expect(read.first_delivered_at!.getTime()).toBe(at(4).getTime());
    expect(read.first_delivered_at!.toISOString()).toBe('2026-10-04T12:00:00.000Z');
    expect(read.first_delivery_at!.getTime()).toBe(read.first_delivered_at!.getTime());

    const view = await contractsService.getById(id, clientId);
    expect(view.deadline!.firstDeliveredAt).toBe('2026-10-04T12:00:00.000Z');
    expect(view.disputeOpensAt).toBe('2026-10-06T12:00:00.000Z');
  });

  it.each(['entrega', 'histórico de entrega', 'histórico de marco', 'marco'])(
    'mantém UTC e escolhe o menor instante legado entre as fontes quando vem de %s',
    async (earliestSource) => {
      const id = await contract();
      const dayFor = (source: string, otherDay: number) =>
        at(source === earliestSource ? 2 : otherDay);
      await delivery(id, dayFor('entrega', 7));
      await history(id, 'delivered', 'Entrega única antiga', dayFor('histórico de entrega', 6));
      await history(
        id,
        'in_progress',
        'Marco «Primeira parte» entregue: versão antiga',
        dayFor('histórico de marco', 5),
      );
      await milestone(id, 'funded', dayFor('marco', 4), null, null);
      // Um evento anterior sem entrega não inaugura a janela de disputa.
      await history(id, 'accepted', 'Proposta aceita', at(1));

      const read = (await contractsRepository.findById(id))!;
      expect(read.first_delivery_at).toBeNull();
      expect(read.first_delivered_at).toBeInstanceOf(Date);
      expect(read.first_delivered_at!.getTime()).toBe(at(2).getTime());
      expect(read.first_delivered_at!.toISOString()).toBe('2026-10-02T12:00:00.000Z');

      const view = await contractsService.getById(id, clientId);
      expect(view.deadline!.firstDeliveredAt).toBe('2026-10-02T12:00:00.000Z');
      expect(view.disputeOpensAt).toBe('2026-10-04T12:00:00.000Z');
      // A leitura de compatibilidade não grava o reparo nem um snapshot inventado.
      expect((await contractsRepository.findById(id))!.first_delivery_at).toBeNull();
    },
  );

  it('mantém NULL sem evidência de entrega e usa o aceite para a abertura publicada', async () => {
    const id = await contract();
    await pool.query('UPDATE contracts SET accepted_at = :accepted WHERE id = :id', {
      id,
      accepted: at(3),
    });
    await milestone(id, 'funded', null, null, null);
    await history(id, 'accepted', 'Proposta aceita', at(3));

    expect(await contractsRepository.findById(id)).toMatchObject({
      first_delivery_at: null,
      first_delivered_at: null,
    });
    const view = await contractsService.getById(id, clientId);
    expect(view.deadline!.firstDeliveredAt).toBeNull();
    expect(view.disputeOpensAt).toBe('2026-10-05T12:00:00.000Z');
  });

  it('conserva a primeira entrega e inclui revisão na abertura, removendo unidades liberadas/canceladas', async () => {
    const id = await contract();
    await milestone(id, 'released', at(2), at(3), at(1));
    await milestone(id, 'approved', at(2), at(3), at(1));
    await milestone(id, 'cancelled', at(3), at(4), at(2));
    await milestone(id, 'funded', null, at(5), at(3)); // nunca entregue: snapshot não vale
    const revised = await milestone(id, 'funded', at(8), null, at(6));
    const delivered = await milestone(id, 'delivered', at(9), at(12), at(7));
    await pool.query(
      `UPDATE contracts SET first_delivery_at = :first, revision_limit = NULL,
                            revisions_used = 256 WHERE id = :id`,
      { id, first: at(4) },
    );
    await pool.query(`UPDATE contract_milestones SET revisions_used = 256 WHERE id = :id`, {
      id: revised,
    });

    const read = await contractsRepository.findById(id);
    expect(read).toMatchObject({
      first_delivery_at: at(4),
      first_delivered_at: at(4),
      next_milestone_approval_at: at(12),
      next_milestone_dispute_opens_at: at(6),
      revision_limit: null,
      revisions_used: 256,
    });
    const milestones = await milestonesRepository.listForContract(id);
    expect(milestones.find((m) => m.id === revised)).toMatchObject({
      dispute_opens_at: at(6),
      revision_limit: null,
      revisions_used: 256,
    });
    expect(await milestonesRepository.findById(id, delivered)).toMatchObject({
      dispute_opens_at: at(7),
      revision_limit: null,
      revisions_used: 0,
    });

    // A aprovação retira a unidade do agregado; uma revisão continua contando.
    await pool.query("UPDATE contract_milestones SET status = 'released' WHERE id = :id", {
      id: revised,
    });
    expect(await contractsRepository.findById(id)).toMatchObject({
      first_delivered_at: at(4),
      next_milestone_dispute_opens_at: at(7),
    });
    await pool.query("UPDATE contract_milestones SET status = 'released' WHERE id = :id", {
      id: delivered,
    });
    expect(await contractsRepository.findById(id)).toMatchObject({
      next_milestone_approval_at: null,
      next_milestone_dispute_opens_at: null,
    });
  });

  it('mantém o fallback de data no legado ainda não reparado e não inventa abertura', async () => {
    const id = await contract();
    await milestone(id, 'funded', at(5), null, null);
    await milestone(id, 'delivered', at(8), at(13), null);
    expect(await contractsRepository.findById(id)).toMatchObject({
      first_delivery_at: null,
      first_delivered_at: at(5),
      delivery_dispute_opens_at: null,
      next_milestone_approval_at: at(13),
      next_milestone_dispute_opens_at: null,
      fee_percentage: null,
      offer_seq: 1,
      revision_limit: null,
      revisions_used: 0,
    });
  });
});
