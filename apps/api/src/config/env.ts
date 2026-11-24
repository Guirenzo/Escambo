/**
 * Configuração da API (camada de config): lê, valida e exporta as variáveis de ambiente.
 *
 * Variável de ambiente é um valor que o sistema ou o Docker entrega ao processo (process.env),
 * fora do código: porta, senha do banco, segredo do JWT. Assim o mesmo código roda no dev, na demo
 * e na produção, mudando só a configuração (RNF-034). No dev os valores ficam no arquivo
 * apps/api/.env (modelo no .env.example), que o import 'dotenv/config' carrega no process.env; o
 * .env nunca vai para o git, porque guarda segredos. Na produção, o compose passa ao contêiner o
 * .env da VPS. Variável que já existe no processo vale mais que a do arquivo.
 *
 * Quem usa: quase todo arquivo importa o `env` daqui (db.ts, server.ts, app.ts, services). Dentro:
 * validadores de chave e de URL, o envSchema (um campo zod por variável), as combinações
 * proibidas (envChecked) e o safeParse que impede a subida se algo estiver errado.
 */
import 'dotenv/config';
import { z } from 'zod';
import { AUDIT_LOG_MIN_RETENTION_DAYS } from '../modules/audit/audit.retention';
import { JOBS_INTERVAL_MAX_MS } from '../utils/human-hours';

// Validadores usados pelos .refine do schema mais abaixo.
/**
 * Chave AES-256 em base64 canônico: 32 bytes, com o "=" final, sem espaço nem o alfabeto do
 * base64url. O Buffer aceitaria quase qualquer texto (ignora o que não entende) e devolveria uma
 * chave curta ou diferente da que foi guardada — e o que fosse cifrado com ela não voltaria.
 */
function isAes256Key(value: string): boolean {
  const key = Buffer.from(value, 'base64');
  return key.length === 32 && key.toString('base64') === value;
}

const FIELD_KEY_HINT = '32 bytes em base64 (gere com "openssl rand -base64 32")';

/** Endereço http(s) absoluto, sem usuário e senha nem fragmento (o Google recusa os dois). */
function isRedirectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/** http(s) num host da própria máquina: 127.0.0.1, localhost ou [::1]. */
function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** https absoluto, sem usuário e senha. */
function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

// Toda variável chega como texto. z.coerce.number() converte em número; o enum de 'true'/'false'
// com transform vira booleano; .default() é o valor quando a variável não existe.
/**
 * Validação das variáveis de ambiente (RNF-034: configs externalizadas).
 * Se faltar/estiver inválida, a API não sobe — falha cedo e claro.
 */
const envSchema = z.object({
  // --- Servidor: ambiente (dev, teste ou produção), porta da API e nível do log ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  // Commit do build (o CI grava na imagem via build-arg); aparece no health e no log de subida.
  GIT_SHA: z.string().default('dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // --- Banco (MySQL): o config/db.ts monta o pool com estes valores. Os padrões são os do dev
  // (localhost:3306, usuário escambo); no Docker o host é o serviço 'db'.
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default('escambo'),
  DB_PASSWORD: z.string().default('escambo'),
  DB_NAME: z.string().default('escambo'),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),

  // --- Autenticação (ADR 6): JWT_SECRET assina o token e é a única variável sem padrão; sem ela
  // a API não sobe. O token de acesso vale JWT_EXPIRES_IN (1h), o refresh vale 7 dias e o
  // BCRYPT_SALT_ROUNDS é o custo do hash da senha (mínimo 12).
  JWT_SECRET: z.string().min(16, 'JWT_SECRET deve ter ao menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(12).default(12),
  REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().int().positive().default(7),
  // Contas com poderes de admin: e-mails separados por vírgula; "@dominio" vale para o domínio todo.
  ADMIN_EMAILS: z.string().default(''),
  // Painel admin só com a verificação em duas etapas ativa (ADR 66): sem ela, /admin/* responde 403
  // mfa_required. Exige FIELD_ENCRYPTION_KEY, que cifra o segredo do app autenticador (RNF-042).
  ADMIN_MFA_REQUIRED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

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
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // Tempo máximo para drenar conexões no encerramento gracioso.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Créditos Escambo (time-bank): bônus concedido uma vez, no primeiro acesso à carteira.
  CREDITS_WELCOME_BONUS: z.coerce.number().int().min(0).default(100),

  // Jobs em background (aprovação tácita etc.). Em cluster, deixe ligado em UMA instância.
  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Até 30 min: os instantes de prazo gravados vão até 20:29 e os jobs só agem até 20:59 (ADR 57).
  JOBS_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(JOBS_INTERVAL_MAX_MS)
    .default(5 * 60_000),

  // Pagamentos (depósitos na carteira, ADR 73). PAYMENT_GATEWAY escolhe quem cobra: 'simulated'
  // (padrão: o PIX simulado do ADR 15, para a demo, o dev e os testes) ou 'mercadopago' (Checkout Pro
  // do Mercado Pago, em sandbox com as credenciais de teste).
  PAYMENT_GATEWAY: z.enum(['simulated', 'mercadopago']).default('simulated'),
  // PAYMENTS_SIMULATE libera o endpoint que "paga" a cobrança PIX simulada (demo/dev/testes) —
  // DESLIGUE em produção. PAYMENT_WEBHOOK_SECRET protege o webhook do gateway simulado (vazio = desligado).
  PAYMENTS_SIMULATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  PAYMENT_WEBHOOK_SECRET: z.string().default(''),
  // Validade da cobrança PIX simulada de um depósito.
  DEPOSIT_EXPIRES_MINUTES: z.coerce.number().int().positive().default(30),
  // Mercado Pago (PAYMENT_GATEWAY=mercadopago): o Access Token da aplicação (o de teste, APP_USR-…
  // das credenciais de teste) e a assinatura secreta dos webhooks (painel > Webhooks). Só na API.
  MERCADOPAGO_ACCESS_TOKEN: z.string().trim().default(''),
  MERCADOPAGO_WEBHOOK_SECRET: z.string().trim().default(''),
  // true = credenciais de teste: o modal de depósito avisa que nada é cobrado de verdade. O link de
  // pagamento é sempre o init_point (ver mercadopago.ts).
  MERCADOPAGO_SANDBOX: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Endereço da API; só muda nos testes. Precisa ser https (o token vai no cabeçalho), salvo na
  // própria máquina.
  MERCADOPAGO_API_URL: z
    .string()
    .trim()
    .default('https://api.mercadopago.com')
    .refine((v) => isLoopbackUrl(v) || isHttpsUrl(v), {
      message: 'MERCADOPAGO_API_URL deve ser https (ou um endereço da própria máquina, nos testes)',
    }),
  // Validade do depósito pelo Mercado Pago, em horas: o boleto compensa em até 3 dias úteis, então
  // a cobrança vive mais que o PIX simulado.
  MERCADOPAGO_DEPOSIT_EXPIRES_HOURS: z.coerce.number().int().positive().max(720).default(72),

  // Arquivos gerados pela API (cópias de dados LGPD). No Docker é um volume.
  DATA_DIR: z.string().default('data'),
  // Por quantos dias a cópia de dados fica disponível para download.
  EXPORT_TTL_DAYS: z.coerce.number().int().positive().default(7),
  // Anexos do chat (imagem, PDF, ZIP) ficam em DATA_DIR/uploads. Limite por arquivo, em MB —
  // o nginx do web aceita até 25 MB (client_max_body_size); acima disso, ajuste os dois.
  UPLOAD_MAX_MB: z.coerce.number().int().positive().max(25).default(10),
  // Uploads por IP por hora.
  UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

  // Endereço público do app (links nos e-mails: confirmar e-mail, redefinir senha, abrir no app).
  APP_URL: z.string().url().default('http://localhost:5173'),
  // E-mail transacional: 'simulated' (caixa de saída no banco, lida no painel admin — demo/dev),
  // 'smtp' (nodemailer com SMTP_*) ou 'off' (testes unitários).
  MAIL_PROVIDER: z.enum(['simulated', 'smtp', 'off']).default('simulated'),
  MAIL_FROM: z.string().default('Escambo <nao-responda@escambo.demo>'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Validade dos links de confirmação de e-mail e de redefinição de senha.
  // Avisos push no navegador (ADR 52): 'simulated' (padrão, nada sai da máquina), 'webpush'
  // (Web Push de verdade com as chaves VAPID) ou 'off' (não envia nada).
  PUSH_PROVIDER: z.enum(['simulated', 'webpush', 'off']).default('simulated'),
  // Aparadas: com espaço nas pontas (valor entre aspas no .env, ou injetado assim) a API subiria e o
  // web-push recusaria a chave em cada envio.
  PUSH_PUBLIC_KEY: z.string().trim().default(''),
  PUSH_PRIVATE_KEY: z.string().trim().default(''),
  PUSH_SUBJECT: z.string().default('mailto:nao-responda@escambo.demo'),
  EMAIL_VERIFY_TTL_HOURS: z.coerce.number().int().positive().default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  // Hora (Brasília, 0–23) a partir da qual saem as coisas diárias: o resumo de notificações, o
  // alerta das buscas salvas e o relatório da meta da moderação aos admins (ADR 55).
  DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  // Hora (Brasília, 0–23) a partir da qual o expurgo diário de anexos do chat roda (ADR 31).
  ATTACHMENT_PURGE_HOUR: z.coerce.number().int().min(0).max(23).default(4),
  // Expurgo do audit_logs (RNF-037): apaga o que tem mais de N dias. Vazio ou 0 = desligado (padrão:
  // a auditoria fica no banco). Menos de 90 não sobe: é a retenção mínima, que o banco também
  // garante (migration 0046). Login com IP é registro de acesso, que o Marco Civil (art. 15) pede
  // por 6 meses: ligado, prefira 180 ou mais.
  AUDIT_LOG_PURGE_DAYS: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .refine((v) => v === 0 || v >= AUDIT_LOG_MIN_RETENTION_DAYS, {
      message: `AUDIT_LOG_PURGE_DAYS deve ser 0 (desligado) ou pelo menos ${AUDIT_LOG_MIN_RETENTION_DAYS} dias (RNF-037)`,
    }),

  // --- Observabilidade (ADR 59) ---
  // Porta do /metrics (Prometheus), num servidor à parte que só a rede interna alcança; 0 = desligado.
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  // Rastreamento de erros no Sentry: vazio = desligado (nada sai da máquina).
  SENTRY_DSN: z.string().default(''),
  // Ambiente mostrado no Sentry (produção, homologação…); vazio = NODE_ENV.
  SENTRY_ENVIRONMENT: z.string().default(''),

  // --- Cifragem de campo (RNF-017) ---
  // Chave AES-256 da chave PIX e dos dados bancários dos saques, e do segredo da verificação em duas
  // etapas (RNF-042, ADR 66). Vazia = os saques gravam em texto puro, como antes, a 2FA fica
  // indisponível (nunca em texto puro) e a API avisa na subida. Fica fora do banco e do repositório: sem ela, o que foi
  // cifrado não volta. O valor nunca aparece na mensagem de erro.
  FIELD_ENCRYPTION_KEY: z
    .string()
    .trim()
    .default('')
    .refine((v) => v === '' || isAes256Key(v), {
      message: `FIELD_ENCRYPTION_KEY deve ter ${FIELD_KEY_HINT}`,
    }),
  // Rotação: chaves anteriores, separadas por vírgula, só para LER o que foi cifrado com elas. Depois
  // de trocar a chave, o fields:encrypt regrava tudo com a atual e estas podem sair.
  FIELD_ENCRYPTION_OLD_KEYS: z
    .string()
    .trim()
    .default('')
    .refine((v) => v === '' || v.split(',').every((k) => isAes256Key(k.trim())), {
      message: `cada chave de FIELD_ENCRYPTION_OLD_KEYS deve ter ${FIELD_KEY_HINT}`,
    }),

  // --- Login com Google (RF-002, 1.54.0) ---
  // O cliente OAuth "Aplicativo da Web" criado no Google Cloud (DEPLOY.md). Sem os dois, o login com
  // Google fica desligado: GET /auth/providers diz { google: false }, as rotas do Google respondem
  // 404 e o botão não aparece. Só um dos dois não sobe. O segredo fica só na API, nunca no web.
  GOOGLE_CLIENT_ID: z.string().trim().default(''),
  GOOGLE_CLIENT_SECRET: z.string().trim().default(''),
  // O endereço de volta, igual ao registrado no Google Cloud. Vazio = APP_URL + /api/auth/google/callback
  // (o web e a API no mesmo domínio, como no compose; no dev, o proxy do Vite leva /api à API).
  GOOGLE_REDIRECT_URI: z
    .string()
    .trim()
    .default('')
    .refine((v) => v === '' || isRedirectUrl(v), {
      message:
        'GOOGLE_REDIRECT_URI deve ser um endereço http(s) completo, como https://SEU_DOMINIO/api/auth/google/callback',
    }),
  // Só para os testes ponta a ponta: um Google falso NA PRÓPRIA MÁQUINA (127.0.0.1, localhost ou
  // [::1]) no lugar dos endereços do Google. Vazio em qualquer servidor de verdade; outro host não sobe.
  GOOGLE_TEST_IDP_URL: z
    .string()
    .trim()
    .default('')
    .refine((v) => v === '' || isLoopbackUrl(v), {
      message:
        'GOOGLE_TEST_IDP_URL só aceita um endereço da própria máquina (127.0.0.1, localhost ou [::1]): é o Google falso dos testes',
    }),
});

/**
 * Combinações que não sobem. Web Push de verdade precisa do par VAPID fixo: sem ele a API subiria e
 * todo push falharia só no uso (gerar um par por processo quebraria as inscrições a cada reinício e
 * entre instâncias). E exigir a 2FA no painel sem a chave que cifra o segredo trancaria o painel:
 * nenhum admin conseguiria ativá-la (ADR 66).
 */
const envChecked = envSchema.superRefine((e, ctx) => {
  if (e.PUSH_PROVIDER === 'webpush') {
    for (const key of ['PUSH_PUBLIC_KEY', 'PUSH_PRIVATE_KEY'] as const) {
      if (e[key] === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `PUSH_PROVIDER=webpush exige ${key} (gere o par com "npx web-push generate-vapid-keys")`,
        });
      }
    }
  }
  // Login com Google pela metade (o id sem o segredo, ou o contrário) é erro de configuração: subir
  // desligado em silêncio esconderia o engano até alguém procurar o botão.
  if ((e.GOOGLE_CLIENT_ID === '') !== (e.GOOGLE_CLIENT_SECRET === '')) {
    const missing = e.GOOGLE_CLIENT_ID === '' ? 'GOOGLE_CLIENT_ID' : 'GOOGLE_CLIENT_SECRET';
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [missing],
      message: `O login com Google precisa de GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET juntos: falta ${missing} (ou deixe os dois vazios para desligar)`,
    });
  }
  // Mercado Pago sem o token não cobra, e sem a assinatura secreta o webhook não tem como conferir
  // quem avisa: os dois juntos, ou a API não sobe.
  if (e.PAYMENT_GATEWAY === 'mercadopago') {
    for (const key of ['MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_WEBHOOK_SECRET'] as const) {
      if (e[key] === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `PAYMENT_GATEWAY=mercadopago exige ${key} (credenciais de teste do painel do Mercado Pago)`,
        });
      }
    }
  }
  if (e.ADMIN_MFA_REQUIRED && e.FIELD_ENCRYPTION_KEY === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ADMIN_MFA_REQUIRED'],
      message: `ADMIN_MFA_REQUIRED=true exige FIELD_ENCRYPTION_KEY (${FIELD_KEY_HINT}): sem ela a verificação em duas etapas fica indisponível e nenhum admin entraria no painel`,
    });
  }
});

// safeParse não lança erro: devolve success com os dados, ou a lista do que está errado. Roda uma
// vez só, no primeiro import deste arquivo, antes de a API abrir a porta.
const parsed = envChecked.safeParse(process.env);

// Falha cedo e claro: mostra cada variável recusada e sai com código 1, em vez de subir errado e
// quebrar no primeiro uso.
if (!parsed.success) {
  console.error('❌ Variáveis de ambiente inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// O resto do código lê env.PORT, env.DB_HOST etc. já no tipo certo (número, booleano) e com os
// padrões aplicados; ninguém mais lê o process.env direto.
export const env = parsed.data;
