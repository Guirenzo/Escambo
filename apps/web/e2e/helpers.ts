import { deflateSync } from 'node:zlib';
import type { APIRequestContext, Page } from '@playwright/test';
import type { ServicePackage } from '@escambo/types';
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

/** Cadastro e login pela API, sem mais nada. */
async function registerAndLogin(
  request: APIRequestContext,
  role: 'client' | 'freelancer',
  email: string,
): Promise<TestUser> {
  await api(request, 'post', '/auth/register', {
    data: { email, password: PASSWORD, role, legalAccepted: true },
  });
  const auth = await api<{ accessToken: string; user: { id: number } }>(
    request,
    'post',
    '/auth/login',
    {
      data: { email, password: PASSWORD },
    },
  );
  return { id: auth.user.id, email, token: auth.accessToken };
}

/**
 * O admin que lê a caixa de saída para confirmar os e-mails das contas de teste: um por execução
 * (o worker é um só), trocado antes de o token de acesso vencer. Ler a caixa de saída é trabalho de
 * equipe e não pede e-mail confirmado; sem confirmar, ele também não entra na lista de quem recebe
 * os avisos da equipe (os chamados de suporte avisam todo admin ativo).
 */
let outboxReader: { admin: TestUser; since: number } | null = null;
async function mailReader(request: APIRequestContext): Promise<TestUser> {
  if (!outboxReader || Date.now() - outboxReader.since > 30 * 60_000) {
    const admin = await registerAndLogin(
      request,
      'client',
      `e2e-admin-${unique()}@admin.escambo.test`,
    );
    outboxReader = { admin, since: Date.now() };
  }
  return outboxReader.admin;
}

/**
 * Registra um usuário novo (e-mail único) e faz login pela API. A conta sai com o e-mail
 * confirmado pelo caminho do produto (o link da caixa de saída): contratar, publicar, pagar,
 * trocar, impulsionar e sacar exigem isso (RF-006). `verified: false` deixa sem confirmar.
 */
export async function createUser(
  request: APIRequestContext,
  role: 'client' | 'freelancer',
  opts: { profile?: boolean; email?: string; verified?: boolean } = {},
): Promise<TestUser> {
  const email = opts.email ?? `e2e-${role}-${unique()}@escambo.test`;
  const user = await registerAndLogin(request, role, email);
  if (opts.verified !== false) await verifyEmail(request, user, await mailReader(request));
  // Freelancer de verdade tem perfil (nome, cidade): é nele que moram nota média e Score.
  if (role === 'freelancer' && opts.profile !== false) {
    await api(request, 'put', '/profiles/freelancer', {
      token: user.token,
      data: { fullName: `Freela ${user.id}`, city: 'Joinville', isAvailable: true },
    });
  }
  return user;
}

/**
 * Cria um serviço para o freelancer (título único para a busca achar só ele). Com `packages`
 * (RF-086), o preço e o prazo do serviço saem do Básico: `price` e `deliveryDays` não vão.
 */
export async function createService(
  request: APIRequestContext,
  owner: TestUser,
  price = 300,
  categoryIndex = 0,
  opts: { title?: string; deliveryDays?: number; packages?: ServicePackage[] } = {},
): Promise<{ id: number; title: string; categoryId: number }> {
  const categories = await api<{ id: number }[]>(request, 'get', '/categories');
  const categoryId = categories[categoryIndex]?.id ?? categories[0]?.id;
  if (categoryId === undefined) throw new Error('O seed de referência não contém categorias.');
  const title = opts.title ?? `Serviço e2e ${unique()}`;
  const svc = await api<{ id: number }>(request, 'post', '/services', {
    token: owner.token,
    data: {
      categoryId,
      title,
      description: 'Serviço criado automaticamente pelos testes ponta a ponta.',
      priceType: 'fixed',
      ...(opts.packages
        ? { packages: opts.packages }
        : { price, deliveryDays: opts.deliveryDays ?? 3 }),
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
  template: 'verify_email' | 'password_reset' | 'email_change' | 'notification' | 'digest',
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

/**
 * Admin de teste: e-mail no domínio liberado por ADMIN_EMAILS (@admin.escambo.test). Age como
 * equipe, que não pede e-mail confirmado (RF-006): nasce sem confirmar, como antes, para não entrar
 * na lista de avisos da equipe de todos os testes; `verified: true` confirma.
 */
export function createAdmin(
  request: APIRequestContext,
  opts: { verified?: boolean } = {},
): Promise<TestUser> {
  return createUser(request, 'client', {
    email: `e2e-admin-${unique()}@admin.escambo.test`,
    profile: false,
    verified: opts.verified ?? false,
  });
}

/**
 * Confirma o e-mail de `user` pelo mesmo caminho do produto: lê o link na caixa de saída
 * (com uma conta admin) e consome o token. As ações críticas exigem e-mail confirmado (RF-006).
 * Conta já confirmada fica como está.
 */
export async function verifyEmail(
  request: APIRequestContext,
  user: TestUser,
  admin?: TestUser,
): Promise<void> {
  const me = await api<{ emailVerified: boolean }>(request, 'get', '/auth/me', {
    token: user.token,
  });
  if (me.emailVerified) return;
  const reader = admin ?? (await mailReader(request));
  const mail = await latestEmail(request, reader, user.id, 'verify_email');
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] ?? '';
  expect(token, 'token de confirmação no e-mail').not.toBe('');
  await api(request, 'post', '/auth/verify-email', { data: { token } });
}

let docSeq = 0;
/** Base de 9 caracteres que não se repete na execução (relógio + contador). */
const docBase = (): string =>
  `${(Date.now() % 1_000_000_000) + docSeq++ * 7919}`.padStart(9, '1').slice(-9);

/** Um CPF válido e único por chamada (RF-020: o CPF é único entre contas). */
export function uniqueCpf(): string {
  const digit = (b: string, n: number): number => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(b[i]) * (n + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  let base = docBase();
  if (/^(\d)\1{8}$/.test(base)) base = `${base.slice(0, 8)}${(Number(base[8]) + 1) % 10}`;
  const first = digit(base, 9);
  return `${base}${first}${digit(`${base}${first}`, 10)}`;
}

/** Um CNPJ alfanumérico válido e único (IN RFB 2.229/2024): "AB" + 10 caracteres e os verificadores. */
export function uniqueCnpj(): string {
  const dv = (b: string): number => {
    let sum = 0;
    let weight = 2;
    for (let i = b.length - 1; i >= 0; i--) {
      sum += (b.charCodeAt(i) - 48) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const base = `AB${unique()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '0')}`
    .padEnd(12, '7')
    .slice(0, 12);
  const first = dv(base);
  return `${base}${first}${dv(`${base}${first}`)}`;
}

/**
 * Valida o CPF de quem vai sacar pelo caminho do produto (RF-020): o perfil de freelancer (criado
 * se faltar) e o CPF com a data de nascimento de um adulto. Devolve o CPF.
 */
export async function verifyCpf(request: APIRequestContext, user: TestUser): Promise<string> {
  const mine = await api<{ freelancer: unknown }>(request, 'get', '/profiles/me', {
    token: user.token,
  });
  if (!mine.freelancer) {
    await api(request, 'put', '/profiles/freelancer', {
      token: user.token,
      data: { fullName: `Freela ${user.id}` },
    });
  }
  const cpf = uniqueCpf();
  await api(request, 'put', '/profiles/me/cpf', {
    token: user.token,
    data: { cpf, birthDate: '1990-05-17' },
  });
  return cpf;
}

/**
 * Conta de empresa (RF-018) com a razão social, o nome fantasia e um CNPJ único. Como em
 * `createUser`, sai com o e-mail confirmado (RF-006: contratar e pagar exigem); `verified: false`
 * deixa sem confirmar.
 */
export async function createCompany(
  request: APIRequestContext,
  opts: { tradeName?: string; legalName?: string; verified?: boolean } = {},
): Promise<TestUser & { ulid: string; cnpj: string; tradeName: string }> {
  const email = `e2e-company-${unique()}@escambo.test`;
  const cnpj = uniqueCnpj();
  const tradeName = opts.tradeName ?? `Empresa ${unique()}`;
  await api(request, 'post', '/auth/register', {
    data: {
      email,
      password: PASSWORD,
      role: 'company',
      legalAccepted: true,
      company: { legalName: opts.legalName ?? `${tradeName} Ltda`, tradeName, cnpj },
    },
  });
  const auth = await api<{ accessToken: string; user: { id: number; ulid: string } }>(
    request,
    'post',
    '/auth/login',
    { data: { email, password: PASSWORD } },
  );
  const user = { id: auth.user.id, email, token: auth.accessToken };
  if (opts.verified !== false) await verifyEmail(request, user, await mailReader(request));
  return { ...user, ulid: auth.user.ulid, cnpj, tradeName };
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

/**
 * Contratação levada até 'completed' pela API (create → accept → deliver → approve). Com `service`
 * null, é a proposta direta ao freelancer, sem serviço publicado (quem ainda não confirmou o e-mail
 * não publica, mas recebe, entrega e é pago).
 */
export async function completeContract(
  request: APIRequestContext,
  client: TestUser,
  freelancer: TestUser,
  service: { id: number; title: string } | null,
): Promise<number> {
  await topUp(request, client, 250);
  const created = await api<{ id: number }>(request, 'post', '/contracts', {
    token: client.token,
    data: {
      freelancerId: freelancer.id,
      ...(service ? { serviceId: service.id } : {}),
      title: service?.title ?? 'Contratação direta e2e',
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

/**
 * Abre a página inicial pública (`/` sem sessão) e espera os dados da API: a taxa nos cartões
 * (o texto sem número diz "descontada", com o número, "descontados") e as categorias.
 */
export async function openLanding(page: Page): Promise<void> {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: /o que você sabe fazer/ }),
  ).toBeVisible();
  await expect(page.getByText(/% sobre o valor, descontados de quem recebe/)).toBeVisible();
  await expect(page.locator('#categorias')).toBeVisible();
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

/** Envia uma imagem pela API de mídia (ADR 36 e 38) e devolve a URL pública. */
export async function uploadImage(
  request: APIRequestContext,
  user: TestUser,
  buffer: Buffer,
  purpose: 'avatar' | 'portfolio' = 'portfolio',
): Promise<string> {
  const res = await request.post('/api/media', {
    headers: { Authorization: `Bearer ${user.token}` },
    multipart: { purpose, file: { name: 'imagem.png', mimeType: 'image/png', buffer } },
  });
  expect(res.ok(), `POST /media → ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { url: string }).url;
}

/** PNG RGB de 8 bits a partir da cor de cada pixel. */
function rgbPng(
  width: number,
  height: number,
  color: (x: number, y: number) => readonly number[],
): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      const [r = 0, g = 0, b = 0] = color(x, y);
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG RGB válido (retângulo verde; quadrado se vier só a largura) para testar upload de imagem. */
export function pngFixture(width = 48, height = width): Buffer {
  return rgbPng(width, height, () => [46, 160, 100]);
}

/**
 * PNG de 9 × 8 blocos com cores sorteadas: tem detalhe para a impressão perceptual (ADR 39), então
 * cada chamada é uma imagem diferente para a lista de bloqueio, mesmo repetindo a execução.
 */
export function noisyPngFixture(cell = 16): Buffer {
  const colors = Array.from({ length: 72 }, () =>
    [0, 0, 0].map(() => Math.floor(Math.random() * 256)),
  );
  return rgbPng(
    9 * cell,
    8 * cell,
    (x, y) => colors[Math.floor(y / cell) * 9 + Math.floor(x / cell)] ?? [],
  );
}

// ---------- datas no fuso do navegador dos testes ----------
// O Playwright abre o navegador em America/Sao_Paulo (playwright.config), mas o processo do
// Node que roda os testes usa o fuso da máquina — UTC no CI. Entre 21h e 0h de Brasília o
// "hoje" dos dois diverge, e qualquer "faltam N dias" ou <input type="date"> comparado com
// new Date() do Node falha. Estas funções calculam no fuso do navegador.
const BROWSER_TZ = 'America/Sao_Paulo';
const DAY_MS = 86_400_000;
const pad2 = (n: number): string => String(n).padStart(2, '0');

function browserDateParts(d: Date, zone: string = BROWSER_TZ): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** Valor de <input type="date"> (AAAA-MM-DD) para daqui a N dias, no fuso do navegador. */
export function inputDatePlus(days: number): string {
  const { y, m, d } = browserDateParts(new Date(Date.now() + days * DAY_MS));
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Valor de <input type="date"> para daqui a N dias no fuso dado (o "hoje" de quem entrega, ADR 58). */
export function inputDatePlusIn(zone: string, days: number): string {
  const { y, m, d } = browserDateParts(new Date(Date.now() + days * DAY_MS), zone);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

const WEEKDAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/**
 * Como o app diz o prazo (ADR 58) para o dia daqui a N dias no fuso de quem entrega:
 * "sex, 02/10/2026, até 23:59". A nota "(horário de X)" fica de fora.
 */
export function deadlineTextPlus(days: number, zone: string = BROWSER_TZ): string {
  const { y, m, d } = browserDateParts(new Date(Date.now() + days * DAY_MS), zone);
  const weekday = WEEKDAY_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  return `${weekday}, ${pad2(d)}/${pad2(m)}/${y}, até 23:59`;
}

/** Como o app exibe a data (dd/mm/aaaa) para daqui a N dias, no fuso do navegador. */
export function brDatePlus(days: number): string {
  const { y, m, d } = browserDateParts(new Date(Date.now() + days * DAY_MS));
  return `${pad2(d)}/${pad2(m)}/${y}`;
}

/** Dia da semana (0 = domingo) e hora de agora no fuso do navegador dos testes. */
export function browserClockNow(): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BROWSER_TZ,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === 'weekday')!.value;
  return {
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday),
    hour: Number(parts.find((p) => p.type === 'hour')!.value),
  };
}

/**
 * Vai a uma área pelo menu principal, como a pessoa faria: no desktop e no tablet o link está na
 * barra lateral; no celular, Ranking, Notificações, Perfil e Suporte ficam na folha do "Mais".
 */
export async function navTo(page: Page, name: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Principal' });
  // O nome do link pode vir seguido do contador ("Notificações 3 não lidas").
  // Os nomes do menu são só letras: entram na expressão sem escapar.
  const label = new RegExp(`^${name}(\\s|$)`);
  const link = nav.getByRole('link', { name: label });
  if (!(await link.isVisible())) {
    const more = nav.getByRole('button', { name: 'Mais' });
    await expect(more).toBeVisible();
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
  }
  await link.click();
}

/**
 * O painel de filtros da busca de serviços: no desktop fica sempre ao lado da lista; no celular
 * abre pelo botão "Filtros". Devolve o painel já aberto.
 */
export async function openFilters(page: Page) {
  const toggle = page.getByRole('button', { name: /^Filtros/ });
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  const panel = page.getByTestId('filters');
  await expect(panel).toBeVisible();
  return panel;
}
