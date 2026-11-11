import { createConnection } from 'mysql2/promise';
import type { TestUser } from './helpers';

/** As fixtures SQL só recebem contas descartáveis registradas pelos próprios testes. */
export function assertE2eUser(user: TestUser): void {
  if (
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    !/^e2e-[^@]+@escambo\.test$/.test(user.email)
  ) {
    throw new Error('A fixture só aceita usuários descartáveis e2e-* @escambo.test.');
  }
}

/** Abre o banco da instância E2E informado explicitamente no processo do Playwright. */
export function connectE2eDb() {
  const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const;
  for (const key of required) {
    if (!process.env[key]?.trim()) throw new Error(`A fixture E2E exige ${key} explícito.`);
  }
  const port = Number(process.env.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('DB_PORT inválido para a fixture E2E.');
  }
  return createConnection({
    host: process.env.DB_HOST,
    port,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: 'Z',
  });
}
