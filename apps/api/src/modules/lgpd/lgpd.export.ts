import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';
import { env } from '../../config/env';

/**
 * Portabilidade (LGPD, art. 18, V): monta a cópia de tudo que a plataforma guarda sobre o
 * titular, em JSON legível, e guarda o arquivo em DATA_DIR/exports. Só leitura no banco.
 */

export const EXPORT_FORMAT_VERSION = '1.0';

const q = async (sql: string, params: { userId: number }): Promise<RowDataPacket[]> => {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows;
};

export async function buildExport(userId: number): Promise<Record<string, unknown>> {
  const p = { userId };
  const [user] = await q(
    `SELECT ulid, email, phone, role, status, email_verified_at, last_login_at, created_at
       FROM users WHERE id = :userId`,
    p,
  );
  const [freelancer] = await q(
    `SELECT full_name, avatar_url, bio, headline, city, state, latitude, longitude, avg_rating,
            total_reviews, total_contracts, response_time_hours, is_available, created_at
       FROM profiles_freelancer WHERE user_id = :userId`,
    p,
  );
  const [client] = await q(
    `SELECT full_name, avatar_url, bio, city, state, latitude, longitude, created_at
       FROM profiles_client WHERE user_id = :userId`,
    p,
  );
  const consents = await q(
    `SELECT type, version, accepted, ip_address, user_agent, created_at
       FROM lgpd_consents WHERE user_id = :userId ORDER BY id`,
    p,
  );
  const services = await q(
    `SELECT id, title, description, price_type, price, delivery_days, is_remote, is_active,
            views_count, created_at, deleted_at
       FROM services WHERE user_id = :userId ORDER BY id`,
    p,
  );
  const contracts = await q(
    `SELECT id, ulid, client_id, freelancer_id, service_id, title, description, price, platform_fee,
            freelancer_net, payment_mode, status, deadline_at, accepted_at, completed_at,
            cancelled_at, created_at
       FROM contracts WHERE client_id = :userId OR freelancer_id = :userId ORDER BY id`,
    p,
  );
  const history = await q(
    `SELECT h.contract_id, h.old_status, h.new_status, h.note, h.created_at
       FROM contract_status_history h
       JOIN contracts c ON c.id = h.contract_id
      WHERE c.client_id = :userId OR c.freelancer_id = :userId
      ORDER BY h.id`,
    p,
  );
  const messages = await q(
    `SELECT m.id, cv.contract_id, m.sender_id, m.type, m.content, m.created_at
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
      WHERE cv.participant_a = :userId OR cv.participant_b = :userId
      ORDER BY m.id`,
    p,
  );
  const reviews = await q(
    `SELECT id, contract_id, reviewer_id, reviewee_id, rating, comment, is_public, created_at
       FROM reviews WHERE reviewer_id = :userId OR reviewee_id = :userId ORDER BY id`,
    p,
  );
  const barters = await q(
    `SELECT id, ulid, proposer_id, receiver_id, offered_service_id, requested_service_id,
            offered_description, requested_description, estimated_value_offered,
            estimated_value_requested, cash_difference, cash_payer_id, platform_fee, torna_status,
            status, created_at
       FROM barter_agreements WHERE proposer_id = :userId OR receiver_id = :userId ORDER BY id`,
    p,
  );
  const [wallet] = await q(
    `SELECT balance, balance_pending, credits_balance, credits_pending, currency
       FROM wallets WHERE user_id = :userId`,
    p,
  );
  const walletTx = await q(
    `SELECT id, amount, pending_delta, balance_after, pending_after, reason, contract_id,
            payment_id, withdrawal_id, created_at
       FROM wallet_transactions WHERE user_id = :userId ORDER BY id`,
    p,
  );
  const creditTx = await q(
    `SELECT id, amount, balance_after, reason, contract_id, created_at
       FROM credit_transactions WHERE user_id = :userId ORDER BY id`,
    p,
  );
  const deposits = await q(
    `SELECT id, amount, method, status, gateway, gateway_payment_id, paid_at, expires_at, created_at
       FROM payments WHERE payer_id = :userId AND kind = 'topup' ORDER BY id`,
    p,
  );
  const withdrawals = await q(
    `SELECT id, amount, status, pix_key, bank_name, bank_agency, bank_account, gateway_ref,
            processed_at, created_at
       FROM withdrawals WHERE user_id = :userId ORDER BY id`,
    p,
  );
  const disputes = await q(
    `SELECT d.id, d.contract_id, d.opened_by, d.reason, d.description, d.status, d.resolution,
            d.refund_percentage, d.resolution_note, d.resolved_at, d.created_at
       FROM disputes d
       JOIN contracts c ON c.id = d.contract_id
      WHERE c.client_id = :userId OR c.freelancer_id = :userId
      ORDER BY d.id`,
    p,
  );
  const reports = await q(
    `SELECT id, target_type, target_id, reason, description, status, created_at
       FROM content_reports WHERE reporter_id = :userId ORDER BY id`,
    p,
  );
  const favorites = await q(
    `SELECT target_type, target_id, created_at FROM favorites WHERE user_id = :userId ORDER BY id`,
    p,
  );
  const notifications = await q(
    `SELECT id, type, title, body, is_read, created_at
       FROM notifications WHERE user_id = :userId ORDER BY id`,
    p,
  );
  const lgpdRequests = await q(
    `SELECT 'exclusao' AS tipo, id, status, reason AS motivo, created_at
       FROM data_deletion_requests WHERE user_id = :userId
      UNION ALL
     SELECT 'exportacao' AS tipo, id, status, NULL AS motivo, created_at
       FROM data_export_requests WHERE user_id = :userId
      ORDER BY created_at`,
    p,
  );

  return {
    formato: `escambo-export/${EXPORT_FORMAT_VERSION}`,
    exportadoEm: new Date().toISOString(),
    titular: { id: userId, ...(user ?? {}) },
    perfis: { freelancer: freelancer ?? null, cliente: client ?? null },
    consentimentos: consents,
    servicos: services,
    contratacoes: contracts,
    historicoDeContratacoes: history,
    mensagens: messages,
    avaliacoes: reviews,
    trocas: barters,
    carteira: {
      saldo: wallet ?? null,
      extratoReais: walletTx,
      extratoCreditos: creditTx,
      depositos: deposits,
      saques: withdrawals,
    },
    disputas: disputes,
    denunciasFeitas: reports,
    favoritos: favorites,
    notificacoes: notifications,
    solicitacoesLgpd: lgpdRequests,
  };
}

// ---------- armazenamento dos arquivos (DATA_DIR/exports) ----------

const exportsDir = (): string => path.resolve(env.DATA_DIR, 'exports');

/** Caminho absoluto de um arquivo pelo nome guardado em `file_url` (nunca sai da pasta). */
export function exportFilePath(fileName: string): string {
  const safe = path.basename(fileName);
  return path.join(exportsDir(), safe);
}

export async function writeExportFile(fileName: string, data: unknown): Promise<number> {
  await mkdir(exportsDir(), { recursive: true });
  const file = exportFilePath(fileName);
  const body = JSON.stringify(data, null, 2);
  await writeFile(file, body, 'utf8');
  return Buffer.byteLength(body, 'utf8');
}

export async function exportFileExists(fileName: string): Promise<boolean> {
  try {
    await stat(exportFilePath(fileName));
    return true;
  } catch {
    return false;
  }
}

export function openExportFile(fileName: string): NodeJS.ReadableStream {
  return createReadStream(exportFilePath(fileName));
}

export async function deleteExportFile(fileName: string): Promise<void> {
  try {
    await unlink(exportFilePath(fileName));
  } catch {
    /* já não existe */
  }
}
