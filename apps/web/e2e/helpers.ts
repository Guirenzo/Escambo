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
): Promise<TestUser> {
  const email = `e2e-${role}-${unique()}@escambo.test`;
  await api(request, 'post', '/auth/register', { data: { email, password: PASSWORD, role } });
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

/** Cria um serviço para o freelancer (título único para a busca achar só ele). */
export async function createService(
  request: APIRequestContext,
  owner: TestUser,
  price = 300,
): Promise<{ id: number; title: string }> {
  const categories = await api<{ id: number }[]>(request, 'get', '/categories');
  const title = `Serviço e2e ${unique()}`;
  const svc = await api<{ id: number }>(request, 'post', '/services', {
    token: owner.token,
    data: {
      categoryId: categories[0].id,
      title,
      description: 'Serviço criado automaticamente pelos testes ponta a ponta.',
      priceType: 'fixed',
      price,
      deliveryDays: 3,
      isRemote: true,
    },
  });
  return { id: svc.id, title };
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
