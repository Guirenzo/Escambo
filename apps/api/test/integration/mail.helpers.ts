import type { Express } from 'express';
import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import { expect } from 'vitest';
import { pool } from '../../src/config/db';

/**
 * Confirma o e-mail de um usuário pelo mesmo caminho do produto: lê o e-mail de confirmação
 * na caixa de saída (provedor simulado, visível a admins) e consome o token do link.
 */
export async function verifyEmailOf(
  app: Express,
  adminToken: string,
  userId: number,
): Promise<void> {
  let token = '';
  for (let i = 0; i < 30 && !token; i++) {
    const res = await request(app)
      .get(`/api/admin/emails?userId=${userId}&limit=20`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(res.status).toBe(200);
    const mail = (res.body as { template: string; text: string }[]).find(
      (e) => e.template === 'verify_email',
    );
    token = mail ? (/token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] ?? '') : '';
    if (!token) await new Promise((r) => setTimeout(r, 100));
  }
  expect(token, `e-mail de confirmação do usuário ${userId} não chegou à caixa de saída`).not.toBe(
    '',
  );
  const ok = await request(app).post('/api/auth/verify-email').send({ token });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
}

/**
 * O mesmo caminho sem conta admin: lê o link de confirmação mais recente da caixa de saída
 * (provedor simulado) direto na tabela e consome o token em POST /auth/verify-email. As contas de
 * teste que contratam, publicam, pagam, trocam, impulsionam ou sacam precisam dele (RF-006).
 */
export async function confirmEmail(app: Express, userId: number): Promise<void> {
  let token = '';
  for (let i = 0; i < 30 && !token; i++) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT text_body FROM email_outbox
        WHERE user_id = :userId AND template = 'verify_email'
        ORDER BY id DESC LIMIT 1`,
      { userId },
    );
    token = /token=([A-Za-z0-9_-]+)/.exec(String(rows[0]?.text_body ?? ''))?.[1] ?? '';
    if (!token) await new Promise((r) => setTimeout(r, 100));
  }
  expect(token, `e-mail de confirmação do usuário ${userId} não chegou à caixa de saída`).not.toBe(
    '',
  );
  const ok = await request(app).post('/api/auth/verify-email').send({ token });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
}
