import mysql from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { appliedMigrations, ensureMigrationsTable, loadMigrations, migrate } from './migrate-core';

/**
 * CLI de migrations. Usa as credenciais da própria API (mesmo database):
 *   npm run db:migrate            # aplica pendentes
 *   npm run db:migrate -- --status  # lista aplicadas x pendentes
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
      const done = await appliedMigrations(conn);
      for (const step of loadMigrations()) {
        const mark = done.has(step.name) ? '✓ aplicada' : '· pendente';
        console.log(`${mark}  ${step.name}`);
      }
      return;
    }

    const result = await migrate(conn);
    logger.info(
      { aplicadas: result.applied, ignoradas: result.skipped.length },
      result.applied.length ? 'Migrations aplicadas' : 'Banco já está atualizado',
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'Falha ao rodar migrations');
  process.exit(1);
});
