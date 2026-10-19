import { createConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { TestUser } from './helpers';

const HOUR = 3_600_000;

/**
 * Prepara apenas as datas de uma entrega histórica de teste. O aceite, o escrow e a
 * entrega já aconteceram pela API real; a disputa e a decisão continuam pela UI.
 * Sem configuração explícita do banco E2E, não há conexão nem alteração.
 */
export async function historicalDisputeDelivery(
  contractId: number,
  client: TestUser,
  freelancer: TestUser,
): Promise<{
  createdAt: string;
  firstDeliveredAt: string;
  opensAt: string;
  approvalDueAt: string;
}> {
  const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const;
  for (const key of required) {
    if (!process.env[key]?.trim()) throw new Error(`Fixture histórica E2E exige ${key} explícito.`);
  }
  const port = Number(process.env.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('DB_PORT inválido para a fixture histórica E2E.');
  }
  for (const user of [client, freelancer]) {
    if (
      !Number.isSafeInteger(user.id) ||
      user.id <= 0 ||
      !/^e2e-[^@]+@escambo\.test$/.test(user.email)
    ) {
      throw new Error(
        'A fixture histórica só aceita os usuários descartáveis e2e-* @escambo.test.',
      );
    }
  }
  if (!Number.isSafeInteger(contractId) || contractId <= 0 || client.id === freelancer.id) {
    throw new Error('Contratação ou participantes inválidos para a fixture histórica E2E.');
  }

  // Próxima aprovação às 9h ou 20h de São Paulo, com ao menos uma hora de folga.
  // Entrega há 48–72h, abertura há 0–24h:
  // conserva a espera de 48h e as 24h mínimas antes da aprovação tácita.
  const now = new Date();
  const approval = new Date(now);
  approval.setUTCHours(12, 0, 0, 0);
  if (approval.getTime() <= now.getTime() + HOUR) approval.setUTCHours(23);
  if (approval.getTime() <= now.getTime() + HOUR) {
    approval.setUTCDate(approval.getUTCDate() + 1);
    approval.setUTCHours(12);
  }
  const firstDelivery = new Date(approval.getTime() - 72 * HOUR);
  const accepted = new Date(firstDelivery.getTime() - 4 * HOUR);
  const created = new Date(accepted.getTime() - HOUR);
  const opens = new Date(firstDelivery.getTime() + 48 * HOUR);
  const params = [contractId, client.id, freelancer.id];
  const conn = await createConnection({
    host: process.env.DB_HOST,
    port,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: 'Z',
  });
  try {
    await conn.beginTransaction();
    const [contracts] = await conn.query<RowDataPacket[]>(
      `SELECT c.id, c.status, c.offer_seq, c.revisions_used, c.deadline_at,
              client.email AS client_email,
              COALESCE(client.timezone, 'America/Sao_Paulo') AS client_timezone,
              freelancer.email AS freelancer_email,
              (SELECT COUNT(*) FROM contract_milestones m WHERE m.contract_id = c.id) AS milestones,
              (SELECT COUNT(*) FROM deliveries d WHERE d.contract_id = c.id) AS deliveries,
              (SELECT COUNT(*) FROM disputes d WHERE d.contract_id = c.id) AS disputes
         FROM contracts c
         JOIN users client ON client.id = c.client_id
         JOIN users freelancer ON freelancer.id = c.freelancer_id
        WHERE c.id = ? AND c.client_id = ? AND c.freelancer_id = ?
          AND c.status = 'delivered' AND c.payment_mode = 'cash'
          AND c.barter_agreement_id IS NULL
        FOR UPDATE`,
      params,
    );
    const row = contracts[0];
    if (
      !row ||
      row.client_email !== client.email ||
      row.freelancer_email !== freelancer.email ||
      row.client_timezone !== 'America/Sao_Paulo' ||
      Number(row.milestones) !== 0 ||
      Number(row.deliveries) !== 1 ||
      Number(row.disputes) !== 0 ||
      Number(row.offer_seq) !== 1 ||
      Number(row.revisions_used) !== 0 ||
      row.deadline_at !== null
    ) {
      throw new Error(
        'Fixture histórica recusada: esperava entrega única nova dos participantes E2E.',
      );
    }
    const [updated] = await conn.query<ResultSetHeader>(
      `UPDATE contracts c
          SET c.created_at = ?, c.accepted_at = ?, c.first_delivery_at = ?,
              c.delivery_dispute_opens_at = ?, c.approval_due_at = ?,
              c.proposal_expires_at = ?, c.updated_at = ?
        WHERE c.id = ? AND c.client_id = ? AND c.freelancer_id = ? AND c.status = 'delivered'
          AND NOT EXISTS (SELECT 1 FROM contract_milestones m WHERE m.contract_id = c.id)`,
      [created, accepted, firstDelivery, opens, approval, opens, firstDelivery, ...params],
    );
    if (updated.affectedRows !== 1) throw new Error('A entrega E2E mudou durante a preparação.');
    await conn.query(
      `UPDATE deliveries SET created_at = ?, delivered_at = ? WHERE contract_id = ?`,
      [firstDelivery, firstDelivery, contractId],
    );
    await conn.query(
      `UPDATE contract_status_history
          SET created_at = CASE new_status WHEN 'pending' THEN ? WHEN 'accepted' THEN ?
            WHEN 'delivered' THEN ? ELSE created_at END
        WHERE contract_id = ? AND changed_by IN (?, ?)`,
      [created, accepted, firstDelivery, ...params],
    );
    await conn.query(
      `UPDATE contract_offers SET created_at = ?, resolved_at = ?, respond_by = ?
        WHERE contract_id = ? AND seq = 1 AND outcome = 'accepted'`,
      [created, accepted, opens, contractId],
    );
    await conn.commit();
    return {
      createdAt: created.toISOString(),
      firstDeliveredAt: firstDelivery.toISOString(),
      opensAt: opens.toISOString(),
      approvalDueAt: approval.toISOString(),
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    await conn.end();
  }
}
