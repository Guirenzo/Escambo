import { pool } from '../config/db';
import { logger } from '../config/logger';
import { sealStoredWithdrawals } from '../modules/withdrawal/withdrawal.backfill';

/**
 * Cifra uma vez (RNF-017) a chave PIX e os dados bancários dos saques gravados em texto puro antes
 * da FIELD_ENCRYPTION_KEY, e regrava com a chave atual o que foi cifrado com uma das
 * FIELD_ENCRYPTION_OLD_KEYS (rotação). Em lotes e idempotente: rodar de novo não regrava nada. Sem
 * a chave não roda (sai com 1, sem tocar no banco). Sai com 1 também se sobrou valor cifrado que
 * não decifra com as chaves configuradas (o resto foi cifrado; veja os warns).
 *   npm run -w @escambo/api fields:encrypt
 *   docker compose -f docker-compose.prod.yml run --rm --no-deps api \
 *     node dist/scripts/encrypt-withdrawal-fields.js
 */
sealStoredWithdrawals()
  .then(async (result) => {
    logger.info(result, 'Destino dos saques cifrado');
    await pool.end();
    process.exit(result.unreadable > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    logger.error({ err }, 'Falha ao cifrar o destino dos saques');
    // Já é o caminho de falha: o pool que não fecha não pode impedir a saída com 1.
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
