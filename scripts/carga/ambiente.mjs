/**
 * Ambiente do teste de carga: banco próprio (escambo_carga), API em processo separado e
 * informações da máquina. Nunca toca no banco `escambo` da demonstração.
 */

import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import { esperar, log, PASTA_TRABALHO } from './lib.mjs';

const execFileP = promisify(execFile);
const AQUI = dirname(fileURLToPath(import.meta.url));

/** Configuração do ambiente, de variáveis CARGA_* com padrões para o MySQL do docker compose. */
export function configAmbiente() {
  const porta = Number(process.env.CARGA_PORTA ?? 3340);
  return {
    apiDir: resolve(process.env.CARGA_API_DIR ?? join(AQUI, '..', '..', 'apps', 'api')),
    porta,
    apiUrl: process.env.CARGA_API_URL ?? `http://127.0.0.1:${porta}/api`,
    db: {
      host: process.env.CARGA_DB_HOST ?? '127.0.0.1',
      port: Number(process.env.CARGA_DB_PORT ?? 3306),
      user: process.env.CARGA_DB_USER ?? 'root',
      // Padrão do docker-compose.yml de desenvolvimento (DB_ROOT_PASSWORD), não é segredo de produção.
      password: process.env.CARGA_DB_PASSWORD ?? 'escambo_root',
      database: process.env.CARGA_DB_NAME ?? 'escambo_carga',
      pool: Number(process.env.CARGA_DB_POOL ?? 10),
    },
  };
}

/** Trava de segurança: o teste só apaga/recria um banco com "carga" no nome. */
function conferirNomeBanco(nome) {
  if (!/^[a-z0-9_]+$/.test(nome) || !nome.includes('carga') || nome === 'escambo') {
    throw new Error(`Banco "${nome}" recusado: o teste de carga só usa bancos com "carga" no nome`);
  }
}

function rodarNode(args, { cwd, env, logPath }) {
  return new Promise((ok, falha) => {
    const fd = openSync(logPath, 'a');
    const filho = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', fd, fd] });
    filho.on('error', falha);
    filho.on('exit', (code) => {
      closeSync(fd);
      if (code === 0) ok();
      else falha(new Error(`${args.join(' ')} saiu com código ${code} (log em ${logPath})`));
    });
  });
}

/** Apaga e recria o banco de carga e aplica baseline + migrations + seed de referência. */
export async function prepararBanco(cfg, logPath) {
  conferirNomeBanco(cfg.db.database);
  const admin = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${cfg.db.database}\``);
    await admin.query(
      `CREATE DATABASE \`${cfg.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.end();
  }
  // O mesmo runner da produção (npm run db:migrate), com as credenciais do banco de carga.
  await rodarNode(['--import', 'tsx', 'src/scripts/migrate.ts'], {
    cwd: cfg.apiDir,
    env: envApi(cfg, 'migrate-sem-segredo-usado-0000'),
    logPath,
  });
}

/** Variáveis da API sob teste. Tudo explícito: nada vem de um .env da máquina. */
export function envApi(cfg, jwtSecret, gitSha = 'carga') {
  return {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(cfg.porta),
    GIT_SHA: gitSha,
    LOG_LEVEL: 'info',
    DB_HOST: cfg.db.host,
    DB_PORT: String(cfg.db.port),
    DB_USER: cfg.db.user,
    DB_PASSWORD: cfg.db.password,
    DB_NAME: cfg.db.database,
    DB_CONNECTION_LIMIT: String(cfg.db.pool),
    JWT_SECRET: jwtSecret,
    // O teste inteiro (seed + carga) cabe com folga; sem refresh no meio da medição.
    JWT_EXPIRES_IN: '24h',
    CORS_ORIGINS: '*',
    // Toda a carga sai do mesmo IP (127.0.0.1): o limite por IP de produção (120/min) barraria
    // o teste no primeiro segundo. O limitador continua no caminho; só o teto sobe.
    RATE_LIMIT_MAX: '1000000000',
    LOGIN_RATE_LIMIT_MAX: '1000000000',
    UPLOAD_RATE_LIMIT_MAX: '1000000',
    JOBS_ENABLED: 'false',
    PAYMENTS_SIMULATE: 'true',
    PAYMENT_WEBHOOK_SECRET: '',
    MAIL_PROVIDER: 'simulated',
    PUSH_PROVIDER: 'simulated',
    METRICS_PORT: '0',
    SENTRY_DSN: '',
    ADMIN_EMAILS: '',
    APP_URL: 'http://localhost:5173',
    DATA_DIR: join(PASTA_TRABALHO, 'data'),
  };
}

async function shaDoCodigo(apiDir) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--short', 'HEAD'], { cwd: apiDir });
    return stdout.trim();
  } catch {
    return 'desconhecido';
  }
}

async function apiNoAr(apiUrl) {
  try {
    const r = await fetch(`${apiUrl}/health`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/**
 * Sobe a API (sem watch) a partir do código TypeScript, com o tsx só como carregador: um único
 * processo Node, que o teste derruba no fim. Espera o /health (com banco) responder 200.
 */
export async function subirApi(cfg, jwtSecret) {
  if (await apiNoAr(cfg.apiUrl)) {
    throw new Error(`Já existe algo respondendo em ${cfg.apiUrl}; escolha outra CARGA_PORTA`);
  }
  mkdirSync(PASTA_TRABALHO, { recursive: true });
  const logPath = join(PASTA_TRABALHO, `api-${Date.now()}.log`);
  const fd = openSync(logPath, 'a');
  const sha = await shaDoCodigo(cfg.apiDir);
  const filho = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: cfg.apiDir,
    env: envApi(cfg, jwtSecret, sha),
    stdio: ['ignore', fd, fd],
  });
  let saiu = null;
  filho.on('exit', (code) => {
    saiu = code ?? -1;
  });
  const limite = performance.now() + 90_000;
  let health = null;
  while (!health) {
    if (saiu !== null) {
      throw new Error(`A API saiu (código ${saiu}) antes de responder; log em ${logPath}`);
    }
    if (performance.now() > limite) {
      filho.kill();
      throw new Error(`A API não respondeu em 90 s; log em ${logPath}`);
    }
    await esperar(500);
    health = await apiNoAr(cfg.apiUrl);
  }
  closeSync(fd);
  log(`API no ar em ${cfg.apiUrl} (pid ${filho.pid}, log ${logPath})`);
  return { filho, pid: filho.pid, logPath, health, sha };
}

/** Derruba a API e confirma que a porta parou de responder. */
export async function derrubarApi(cfg, api) {
  if (!api?.filho) return true;
  if (api.filho.exitCode === null) {
    const saida = new Promise((ok) => api.filho.once('exit', ok));
    api.filho.kill();
    await Promise.race([saida, esperar(10_000)]);
    if (api.filho.exitCode === null && process.platform === 'win32') {
      await execFileP('taskkill', ['/PID', String(api.pid), '/T', '/F']).catch(() => undefined);
    }
  }
  const respondendo = await apiNoAr(cfg.apiUrl);
  log(respondendo ? 'ATENÇÃO: a API ainda responde' : `API derrubada (pid ${api.pid})`);
  return !respondendo;
}

/** CPU acumulada (s) e memória (MB) de um processo. Windows via PowerShell; senão, ps. */
export async function amostraProcesso(pid) {
  try {
    if (process.platform === 'win32') {
      const cmd = `$p = Get-Process -Id ${pid}; '{0} {1}' -f $p.TotalProcessorTime.TotalSeconds.ToString([cultureinfo]::InvariantCulture), $p.WorkingSet64`;
      const { stdout } = await execFileP('powershell', ['-NoProfile', '-Command', cmd]);
      const [cpu, mem] = stdout.trim().split(/\s+/).map(Number);
      return { t: performance.now(), cpuSeg: cpu, memMB: Math.round(mem / 2 ** 20) };
    }
    const { stdout } = await execFileP('ps', ['-o', 'cputimes=,rss=', '-p', String(pid)]);
    const [cpu, rss] = stdout.trim().split(/\s+/).map(Number);
    return { t: performance.now(), cpuSeg: cpu, memMB: Math.round(rss / 1024) };
  } catch {
    return null;
  }
}

/** Uso médio de CPU (em núcleos) entre duas amostras. */
export function usoCpu(a, b) {
  if (!a || !b) return null;
  return Math.round(((b.cpuSeg - a.cpuSeg) / ((b.t - a.t) / 1000)) * 100) / 100;
}

/** Retrato do container do MySQL (CPU% e memória), só leitura. */
export async function amostraMysql(
  container = process.env.CARGA_MYSQL_CONTAINER ?? 'escambo-mysql',
) {
  try {
    const { stdout } = await execFileP('docker', [
      'stats',
      '--no-stream',
      '--format',
      '{{.CPUPerc}};{{.MemUsage}}',
      container,
    ]);
    const [cpu, mem] = stdout.trim().split(';');
    return { cpu, mem };
  } catch {
    return null;
  }
}

/**
 * Observador do MySQL (só leitura): estatística por consulta normalizada do performance_schema
 * no banco de carga e quais outros bancos do mesmo servidor estão executando algo (interferência
 * de outros processos, como testes de integração rodando no mesmo container).
 */
export async function abrirMonitorBanco(cfg) {
  const c = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  return {
    async digests() {
      const [rows] = await c.query(
        `SELECT DIGEST AS d, LEFT(DIGEST_TEXT, 200) AS t, COUNT_STAR AS n, SUM_TIMER_WAIT AS s,
                SUM_ROWS_EXAMINED AS e
           FROM performance_schema.events_statements_summary_by_digest
          WHERE SCHEMA_NAME = ?`,
        [cfg.db.database],
      );
      return new Map(
        rows.map((r) => [r.d, { t: r.t, n: Number(r.n), s: Number(r.s), e: Number(r.e) }]),
      );
    },
    async outrosBancosAtivos() {
      const [rows] = await c.query(
        `SELECT DISTINCT DB AS db FROM information_schema.PROCESSLIST
          WHERE COMMAND NOT IN ('Sleep', 'Daemon') AND DB IS NOT NULL AND DB <> ?`,
        [cfg.db.database],
      );
      return rows.map((r) => r.db);
    },
    fechar: () => c.end(),
  };
}

/** Diferença de duas fotos de digests: comandos por requisição e as consultas mais caras. */
export function deltaDigests(antes, depois, requisicoes) {
  let comandos = 0;
  let escritas = 0;
  let commits = 0;
  const itens = [];
  for (const [d, b] of depois) {
    const a = antes.get(d) ?? { n: 0, s: 0, e: 0 };
    const n = b.n - a.n;
    if (n <= 0) continue;
    const ps = b.s - a.s;
    comandos += n;
    if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(b.t)) escritas += n;
    if (/^COMMIT\b/i.test(b.t)) commits += n;
    itens.push({
      sql: b.t.replace(/\s+/g, ' ').slice(0, 160),
      execucoes: n,
      msMedio: Math.round((ps / n / 1e9) * 100) / 100,
      segundosTotal: Math.round((ps / 1e12) * 10) / 10,
      linhasExaminadasPorExec: Math.round((b.e - a.e) / n),
    });
  }
  itens.sort((x, y) => y.segundosTotal - x.segundosTotal);
  const porReq = (x) => (requisicoes ? Math.round((x / requisicoes) * 10) / 10 : null);
  return {
    comandos,
    comandosPorRequisicao: porReq(comandos),
    escritasPorRequisicao: porReq(escritas),
    commitsExplicitosPorRequisicao: porReq(commits),
    maisCaras: itens.slice(0, 6),
  };
}

async function comando(arquivo, args) {
  try {
    const { stdout } = await execFileP(arquivo, args);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Máquina, versões e configuração que entram no relatório. */
export async function infoMaquina(cfg) {
  const cpus = os.cpus();
  let nucleosFisicos = null;
  if (process.platform === 'win32') {
    const s = await comando('powershell', [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum',
    ]);
    nucleosFisicos = s ? Number(s) : null;
  }
  let mysqlInfo = null;
  try {
    const c = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
    });
    const [rows] = await c.query(
      'SELECT VERSION() AS versao, @@innodb_buffer_pool_size AS bufferPool, @@max_connections AS maxConexoes',
    );
    await c.end();
    mysqlInfo = {
      versao: rows[0].versao,
      bufferPoolMB: Math.round(Number(rows[0].bufferPool) / 2 ** 20),
      maxConexoes: Number(rows[0].maxConexoes),
    };
  } catch {
    mysqlInfo = null;
  }
  const docker = await comando('docker', [
    'info',
    '--format',
    '{{.ServerVersion}};{{.OperatingSystem}};{{.NCPU}};{{.MemTotal}}',
  ]);
  let dockerInfo = null;
  if (docker) {
    const [versao, so, ncpu, mem] = docker.split(';');
    dockerInfo = { versao, so, cpus: Number(ncpu), memoriaGB: Math.round(Number(mem) / 2 ** 30) };
  }
  let versaoApi = null;
  try {
    versaoApi = JSON.parse(readFileSync(join(cfg.apiDir, 'package.json'), 'utf8')).version;
  } catch {
    versaoApi = null;
  }
  return {
    cpu: cpus[0]?.model.trim(),
    nucleosLogicos: cpus.length,
    nucleosFisicos,
    memoriaGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    so: `${os.version()} (${os.release()})`,
    node: process.version,
    mysql: mysqlInfo,
    docker: dockerInfo,
    versaoApi,
  };
}
