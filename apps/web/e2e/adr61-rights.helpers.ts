import type { ContractWithHistory, CreateContractRequest, Wallet } from '@escambo/types';
import { expect, type APIRequestContext } from '@playwright/test';
import type { TestUser } from './helpers';

export const bearer = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

/** Dados preparados pela API real; as ações novas continuam exercidas pela interface. */
export async function post<T>(
  request: APIRequestContext,
  user: TestUser,
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await request.post(`/api${path}`, { headers: bearer(user), data });
  expect(response.ok(), `POST ${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

export async function get<T>(request: APIRequestContext, user: TestUser, path: string): Promise<T> {
  const response = await request.get(`/api${path}`, { headers: bearer(user) });
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

export async function acceptContract(
  request: APIRequestContext,
  client: TestUser,
  freelancer: TestUser,
  input: Omit<CreateContractRequest, 'freelancerId'>,
): Promise<number> {
  const { id } = await post<{ id: number }>(request, client, '/contracts', {
    ...input,
    freelancerId: freelancer.id,
  });
  await post(request, freelancer, `/contracts/${id}/accept`);
  return id;
}

export const contract = (request: APIRequestContext, user: TestUser, id: number) =>
  get<ContractWithHistory>(request, user, `/contracts/${id}`);

/** Saldo e extrato: acordo/decisão de reputação não podem repetir a liquidação financeira. */
export async function financialSnapshot(request: APIRequestContext, user: TestUser) {
  return {
    wallet: await get<Wallet>(request, user, '/wallet'),
    transactions: await get<unknown>(request, user, '/wallet/transactions?limit=100'),
  };
}
