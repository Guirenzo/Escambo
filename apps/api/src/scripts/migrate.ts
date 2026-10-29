import mysql from 'mysql2/promise';
import { pool } from '../config/db';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { runRepairDeadlines } from '../jobs/repair-deadlines';
import {
  appliedChecksums,
  changedMigrations,
  ensureMigrationsTable,
  loadMigrations,
  migrate,
  seedReferenceIfEmpty,
} from './migrate-core';

/**
 * CLI de migrations. Usa as credenciais da própria API (mesmo database):
 *   npm run db:migrate            # aplica pendentes (+ seed de referência se o catálogo estiver vazio)
 *   npm run db:migrate -- --status  # lista aplicadas x pendentes (e as alteradas depois de aplicadas)
 */
async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    multipleStatements: true,
  });

  try {
    if (statusOnly) {
      await ensureMigrationsTable(conn);
      const applied = await appliedChecksums(conn);
      const steps = loadMigrations();
      const changed = new Set(changedMigrations(steps, applied));
      for (const step of steps) {
        const mark = changed.has(step.name)
          ? '✗ alterada depois de aplicada'
          : applied.has(step.name)
            ? '✓ aplicada'
            : '· pendente';
        console.log(`${mark}  ${step.name}`);
      }
      return;
    }

    const result = await migrate(conn);
    logger.info(
      { aplicadas: result.applied, ignoradas: result.skipped.length },
      result.applied.length ? 'Migrations aplicadas' : 'Banco já está atualizado',
    );
    if (await seedReferenceIfEmpty(conn)) {
      logger.info('Seed de referência carregado (catálogo estava vazio)');
    }
    // Prazos (ADR 57): as contratações em andamento ganham as horas gravadas antes de a API nova
    // subir. O reparo também roda em toda rodada dos jobs, então uma falha aqui não barra o deploy.
    try {
      logger.info({ reparo: await runRepairDeadlines() }, 'Prazos reparados');
    } catch (err) {
      logger.warn({ err }, 'Reparo dos prazos falhou; a próxima rodada dos jobs tenta de novo');
    }
  } finally {
    await conn.end();
    await pool.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'Falha ao rodar migrations');
  process.exit(1);
});
