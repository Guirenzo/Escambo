import 'dotenv/config';
import { z } from 'zod';

/**
 * Validação das variáveis de ambiente (RNF-034: configs externalizadas).
 * Se faltar/estiver inválida, a API não sobe — falha cedo e claro.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default('escambo'),
  DB_PASSWORD: z.string().default('escambo'),
  DB_NAME: z.string().default('escambo'),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET deve ter ao menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(12).default(12),
  REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().int().positive().default(7),

  // --- Hardening HTTP / operacional ---
  // Origens permitidas no CORS: '*' (qualquer) ou lista separada por vírgula.
  CORS_ORIGINS: z.string().default('*'),
  // Limite do corpo das requisições JSON (proteção básica contra payloads gigantes).
  BODY_LIMIT: z.string().default('1mb'),
  // Confiança em proxies reversos (X-Forwarded-For): 'false' | 'true' | 'loopback' | nº de hops.
  TRUST_PROXY: z.string().default('loopback'),
  // Rate limiting (por IP).
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(5 * 60_000),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // Tempo máximo para drenar conexões no encerramento gracioso.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Variáveis de ambiente inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
