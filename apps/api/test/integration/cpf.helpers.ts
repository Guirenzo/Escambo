import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';

/** Dígito verificador do CPF para os `n` primeiros dígitos (pesos de n+1 a 2, módulo 11). */
function digit(base: string, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Number(base[i]) * (n + 1 - i);
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
}

/**
 * Um CPF válido e diferente a cada chamada (RF-020: o CPF é único entre contas). A base sai do
 * relógio e de um contador, para duas suítes no mesmo banco não sortearem o mesmo; nunca todos
 * iguais.
 */
let seq = 0;
export function uniqueCpf(): string {
  const base = `${(Date.now() % 1_000_000_000) + seq++}`.padStart(9, '1').slice(-9);
  const nine = /^(\d)\1{8}$/.test(base) ? `${base.slice(0, 8)}${(Number(base[8]) + 1) % 10}` : base;
  const first = digit(nine, 9);
  return `${nine}${first}${digit(`${nine}${first}`, 10)}`;
}

/**
 * Valida o CPF de quem vai sacar pelo mesmo caminho do produto (RF-020): o perfil de freelancer
 * (criado se faltar) e o PUT /profiles/me/cpf com a data de nascimento de um adulto. O saque de
 * quem entrega trabalho exige isso além do e-mail confirmado.
 */
export async function verifyCpfOf(app: Express, token: string, cpf = uniqueCpf()): Promise<string> {
  const auth = { Authorization: `Bearer ${token}` };
  const mine = await request(app).get('/api/profiles/me').set(auth);
  expect(mine.status).toBe(200);
  if (!mine.body.freelancer) {
    const created = await request(app)
      .put('/api/profiles/freelancer')
      .set(auth)
      .send({ fullName: 'Freela com CPF' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
  }
  const res = await request(app)
    .put('/api/profiles/me/cpf')
    .set(auth)
    .send({ cpf, birthDate: '1990-05-17' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.verified).toBe(true);
  return cpf;
}
