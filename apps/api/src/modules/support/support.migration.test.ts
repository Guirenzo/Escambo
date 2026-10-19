import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(join(__dirname, '../../../db/migrations/0034_suporte_sla.sql'), 'utf8');
describe('migração aditiva e retomável de suporte', () => {
  it('primeira resposta legada usa apenas mensagem pública alheia ao titular', () => {
    expect(sql).toMatch(
      /MIN\(m\.created_at\)[\s\S]*m\.is_internal = 0 AND m\.sender_id <> t\.user_id/,
    );
    expect(sql).toContain('COALESCE(t.first_response_at,');
    expect(sql).toContain('COALESCE(t.sla_due_at,');
    expect(sql).toContain('t.updated_at = t.updated_at');
    expect(sql).not.toMatch(/DELETE FROM|DROP TABLE|TRUNCATE|UPDATE contracts|UPDATE wallets/i);
  });
  it('retry detecta colunas e índices aplicados antes do auto-commit, no database atual', () => {
    expect(sql).toContain('information_schema.columns');
    expect(sql).toContain('information_schema.statistics');
    expect(sql.match(/present\.table_schema = DATABASE\(\)/g)).toHaveLength(2);
    expect(sql).toContain('WHERE present.column_name IS NULL');
    expect(sql).toContain('WHERE present.index_name IS NULL');
    expect(sql.match(/PREPARE escambo_support_migration FROM @support_sql/g)).toHaveLength(2);
    expect(sql.match(/DEALLOCATE PREPARE escambo_support_migration/g)).toHaveLength(2);
  });
});
