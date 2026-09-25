import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/db', () => ({
  pool: { query: vi.fn() },
}));

import { pool } from '../../config/db';
import { buildExport, EXPORT_FORMAT_VERSION } from './lgpd.export';

const query = vi.mocked(pool.query);

/**
 * A cópia de dados no formato 1.7 (ADR 54 e 56): o que entra, e o que não pode entrar. O banco é
 * mockado: o que se prova é o SQL que a exportação manda e as chaves do arquivo.
 */
beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue([[], []] as never);
});

const sqlSent = (): string[] => query.mock.calls.map((c) => String(c[0]));

describe('cópia de dados 1.7 (ADR 54 e 56)', () => {
  it('declara o formato novo e as seções novas, mesmo vazias', async () => {
    const out = await buildExport(7);
    expect(EXPORT_FORMAT_VERSION).toBe('1.7');
    expect(out).toHaveProperty('avisosNoNavegador', []);
    expect(out).toHaveProperty('sessoes', []);
    expect(out).toHaveProperty('registrosDeSeguranca', []);
    expect(out).toHaveProperty('emailsEnviados', []);
  });

  it('o titular traz a janela de silêncio; as notificações trazem a marca de retido', async () => {
    await buildExport(7);
    const sql = sqlSent();
    expect(sql.find((s) => s.includes('FROM users WHERE id'))).toContain(
      'push_quiet_start, push_quiet_end, push_quiet_pass',
    );
    expect(sql.find((s) => s.includes('FROM notifications WHERE'))).toContain(
      'push_held_at AS push_retido_em',
    );
  });

  it('o titular traz o que deixa sair no silêncio como lista, ou null se nunca escolheu (ADR 56)', async () => {
    const titular = async (pass: string | null) => {
      query.mockImplementation((async (sql: string) =>
        sql.includes('FROM users WHERE id')
          ? [[{ email: 'a@escambo.test', push_quiet_pass: pass }], []]
          : [[], []]) as never);
      return ((await buildExport(7)) as { titular: Record<string, unknown> }).titular;
    };
    expect((await titular('deadline')).push_quiet_pass).toEqual(['deadline']);
    expect((await titular('')).push_quiet_pass).toEqual([]);
    expect((await titular(null)).push_quiet_pass).toBeNull();
  });

  it('a assinatura sai com o segredo como impressão, nunca cru, e sem o navegador', async () => {
    await buildExport(7);
    const sub = sqlSent().find((s) => s.includes('FROM push_subscriptions'))!;
    expect(sub).toContain('SHA2(auth_key, 256)');
    expect(sub).not.toMatch(/,\s*auth_key\s*,/);
    expect(sub).not.toContain('user_agent');
  });

  it('os registros de segurança saem sem old_value/new_value, e os e-mails sem o HTML', async () => {
    await buildExport(7);
    const audit = sqlSent().find((s) => s.includes('FROM audit_logs'))!;
    expect(audit).not.toContain('old_value');
    expect(audit).not.toContain('new_value');
    const mail = sqlSent().find((s) => s.includes('FROM email_outbox'))!;
    expect(mail).toContain('text_body');
    expect(mail).not.toContain('html_body');
    const sessions = sqlSent().find((s) => s.includes('FROM user_sessions'))!;
    expect(sessions).not.toContain('refresh_token');
  });
});
