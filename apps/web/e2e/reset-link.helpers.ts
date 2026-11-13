import { createHash, randomBytes } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import { assertE2eUser, connectE2eDb } from './db.helpers';
import type { TestUser } from './helpers';

/**
 * Substitui o hash do pedido recém-criado por uma credencial descartável, sem ler links da fila.
 * A entrega ao provedor é coberta em auth-email.int.test.ts.
 */
export async function resetLinkForTest(user: TestUser): Promise<{ url: string; token: string }> {
  assertE2eUser(user);
  const token = randomBytes(48).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const db = await connectE2eDb();
  try {
    const [updated] = await db.execute<ResultSetHeader>(
      `UPDATE password_reset_tokens r
        JOIN users u ON u.id = r.user_id
         SET r.token = ?
       WHERE u.id = ? AND u.email = ? AND u.deleted_at IS NULL
         AND r.used_at IS NULL AND r.expires_at > NOW()`,
      [hash, user.id, user.email],
    );
    if (updated.affectedRows !== 1) {
      throw new Error('Esperava um pedido ativo de redefinição para a conta descartável.');
    }
    return { url: `/redefinir-senha?token=${token}`, token };
  } finally {
    await db.end();
  }
}
