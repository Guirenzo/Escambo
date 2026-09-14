import { deflateSync } from 'node:zlib';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Utilitários dos testes e2e: criam usuários e dados pela API (rápido e determinístico)
 * e injetam o token no localStorage para a UI já abrir autenticada — só o teste de login
 * passa pelo formulário de verdade.
 */

export const PASSWORD = 'Escambo@123';
const TOKEN_KEY = 'escambo_token'; // mesmo nome usado em src/lib/api.ts

export interface TestUser {
  id: number;
  email: string;
  token: string;
}

const unique = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function api<T>(
  request: APIRequestContext,
  method: 'get' | 'post' | 'put',
  path: string,
  opts: { token?: string; data?: unknown } = {},
): Promise<T> {
  const res = await request[method](`/api${path}`, {
    data: opts.data,
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
  });
  expect(
    res.ok(),
    `${method.toUpperCase()} ${path} → ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  return (await res.json()) as T;
}

/** Registra um usuário novo (e-mail único) e faz login pela API. */
export async function createUser(
  request: APIRequestContext,
  role: 'client' | 'freelancer',
  opts: { profile?: boolean; email?: string } = {},
): Promise<TestUser> {
  const email = opts.email ?? `e2e-${role}-${unique()}@escambo.test`;
  await api(request, 'post', '/auth/register', { data: { email, password: PASSWORD, role } });
  const auth = await api<{ accessToken: string; user: { id: number } }>(
    request,
    'post',
    '/auth/login',
    {
      data: { email, password: PASSWORD },
    },
  );
  const user = { id: auth.user.id, email, token: auth.accessToken };
  // Freelancer de verdade tem perfil (nome, cidade): é nele que moram nota média e Score.
  if (role === 'freelancer' && opts.profile !== false) {
    await api(request, 'put', '/profiles/freelancer', {
      token: user.token,
      data: { fullName: `Freela ${user.id}`, city: 'Joinville', isAvailable: true },
    });
  }
  return user;
}

/** Cria um serviço para o freelancer (título único para a busca achar só ele). */
export async function createService(
  request: APIRequestContext,
  owner: TestUser,
  price = 300,
  categoryIndex = 0,
  opts: { title?: string; deliveryDays?: number } = {},
): Promise<{ id: number; title: string; categoryId: number }> {
  const categories = await api<{ id: number }[]>(request, 'get', '/categories');
  const categoryId = categories[categoryIndex]?.id ?? categories[0].id;
  const title = opts.title ?? `Serviço e2e ${unique()}`;
  const svc = await api<{ id: number }>(request, 'post', '/services', {
    token: owner.token,
    data: {
      categoryId,
      title,
      description: 'Serviço criado automaticamente pelos testes ponta a ponta.',
      priceType: 'fixed',
      price,
      deliveryDays: opts.deliveryDays ?? 3,
      isRemote: true,
    },
  });
  return { id: svc.id, title, categoryId };
}

/**
 * Carteira pré-paga: propostas em dinheiro exigem saldo. Deposita via cobrança PIX do gateway
 * simulado e confirma o pagamento (PAYMENTS_SIMULATE).
 */
export async function topUp(
  request: APIRequestContext,
  user: TestUser,
  amount: number,
): Promise<void> {
  const deposit = await api<{ id: number }>(request, 'post', '/wallet/deposits', {
    token: user.token,
    data: { amount },
  });
  await api(request, 'post', `/wallet/deposits/${deposit.id}/simulate`, { token: user.token });
}

/**
 * Último e-mail gerado para um usuário (provedor simulado: a caixa de saída é a entrega).
 * Lido com uma conta admin; devolve o texto, de onde os testes tiram os links.
 */
export async function latestEmail(
  request: APIRequestContext,
  admin: TestUser,
  userId: number,
  template: 'verify_email' | 'password_reset' | 'notification' | 'digest',
): Promise<{ subject: string; text: string }> {
  for (let i = 0; i < 20; i++) {
    const list = await api<{ template: string; subject: string; text: string }[]>(
      request,
      'get',
      `/admin/emails?userId=${userId}&limit=20`,
      { token: admin.token },
    );
    const found = list.find((e) => e.template === template);
    if (found) return { subject: found.subject, text: found.text };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`e-mail ${template} do usuário ${userId} não apareceu na caixa de saída`);
}

/** Primeiro link http(s) de um texto de e-mail. */
export const linkIn = (text: string): string => /https?:\/\/\S+/.exec(text)?.[0] ?? '';

/** Admin de teste: e-mail no domínio liberado por ADMIN_EMAILS (@admin.escambo.test). */
export function createAdmin(request: APIRequestContext): Promise<TestUser> {
  return createUser(request, 'client', {
    email: `e2e-admin-${unique()}@admin.escambo.test`,
    profile: false,
  });
}

/**
 * Confirma o e-mail de `user` pelo mesmo caminho do produto: lê o link na caixa de saída
 * (com uma conta admin) e consome o token. Saque exige e-mail confirmado.
 */
export async function verifyEmail(
  request: APIRequestContext,
  user: TestUser,
  admin?: TestUser,
): Promise<void> {
  const reader = admin ?? (await createAdmin(request));
  const mail = await latestEmail(request, reader, user.id, 'verify_email');
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] ?? '';
  expect(token, 'token de confirmação no e-mail').not.toBe('');
  await api(request, 'post', '/auth/verify-email', { data: { token } });
}

/** Contratação levada até 'delivered' pela API (create → accept → deliver). */
export async function deliveredContract(
  request: APIRequestContext,
  client: TestUser,
  freelancer: TestUser,
  service: { id: number; title: string },
): Promise<number> {
  await topUp(request, client, 250);
  const created = await api<{ id: number }>(request, 'post', '/contracts', {
    token: client.token,
    data: {
      freelancerId: freelancer.id,
      serviceId: service.id,
      title: service.title,
      description: 'Contratação criada pelos testes ponta a ponta e entregue.',
      price: 250,
    },
  });
  await api(request, 'post', `/contracts/${created.id}/accept`, { token: freelancer.token });
  await api(request, 'post', `/contracts/${created.id}/deliver`, {
    token: freelancer.token,
    data: { message: 'Entregue.' },
  });
  return created.id;
}

/** Contratação levada até 'completed' pela API (create → accept → deliver → approve). */
export async function completeContract(
  request: APIRequestContext,
  client: TestUser,
  freelancer: TestUser,
  service: { id: number; title: string },
): Promise<number> {
  await topUp(request, client, 250);
  const created = await api<{ id: number }>(request, 'post', '/contracts', {
    token: client.token,
    data: {
      freelancerId: freelancer.id,
      serviceId: service.id,
      title: service.title,
      description: 'Contratação criada pelos testes ponta a ponta e levada até a conclusão.',
      price: 250,
    },
  });
  for (const [who, action, data] of [
    [freelancer, 'accept', undefined],
    [freelancer, 'deliver', { message: 'Entregue.' }],
    [client, 'approve', undefined],
  ] as const) {
    await api(request, 'post', `/contracts/${created.id}/${action}`, { token: who.token, data });
  }
  return created.id;
}

/** Abre a UI já autenticada como `user` (token no localStorage antes do primeiro script). */
export async function openAs(page: Page, user: TestUser, path = '/'): Promise<void> {
  await page.addInitScript(
    ([key, token]) => {
      window.localStorage.setItem(key, token);
    },
    [TOKEN_KEY, user.token] as const,
  );
  await page.goto(path);
}

/** Espera a tela terminar de carregar (nenhum skeleton na tela). */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator('.skeleton')).toHaveCount(0);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** PNG RGB válido (quadrado verde) para testar upload/render de imagem. */
export function pngFixture(size = 48): Buffer {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = 46;
      raw[o + 1] = 160;
      raw[o + 2] = 100;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
