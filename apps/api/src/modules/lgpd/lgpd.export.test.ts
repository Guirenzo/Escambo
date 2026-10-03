import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/db', () => ({
  pool: { query: vi.fn() },
}));

import { pool } from '../../config/db';
import { env } from '../../config/env';
import {
  buildExport,
  deleteExportFile,
  EXPORT_FORMAT_VERSION,
  exportFileExists,
  exportFilePath,
  openExportFile,
  writeExportFile,
} from './lgpd.export';

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

/** Uma consulta da exportação, achada pelo trecho que a identifica, com os espaços reduzidos. */
const sentQuery = (fragment: string): string => {
  const found = sqlSent()
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.includes(fragment));
  expect(found, `consulta com "${fragment}"`).toHaveLength(1);
  return found[0]!;
};

describe('cópia de dados: de quem é cada coisa (LGPD art. 18, V)', () => {
  it('toda consulta é presa ao titular: o mesmo userId em todas, e nenhuma sem o filtro', async () => {
    await buildExport(7);
    expect(query.mock.calls.length).toBeGreaterThanOrEqual(26);
    for (const [sql, params] of query.mock.calls) {
      expect(params, String(sql)).toEqual({ userId: 7 });
      expect(String(sql)).toContain(':userId');
      // Só leitura: a exportação nunca escreve no banco.
      expect(String(sql).trim()).toMatch(/^SELECT\b/);
    }
  });

  it('o que tem duas partes entra quando o titular é qualquer uma delas', async () => {
    await buildExport(7);
    expect(sentQuery('FROM contracts WHERE')).toContain(
      'FROM contracts WHERE client_id = :userId OR freelancer_id = :userId ORDER BY id',
    );
    expect(sentQuery('FROM contract_status_history')).toContain(
      'JOIN contracts c ON c.id = h.contract_id WHERE c.client_id = :userId OR c.freelancer_id = :userId ORDER BY h.id',
    );
    expect(sentQuery('FROM messages m')).toContain(
      'JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.participant_a = :userId OR cv.participant_b = :userId ORDER BY m.id',
    );
    expect(sentQuery('FROM reviews WHERE')).toContain(
      'FROM reviews WHERE reviewer_id = :userId OR reviewee_id = :userId ORDER BY id',
    );
    expect(sentQuery('FROM barter_agreements')).toContain(
      'FROM barter_agreements WHERE proposer_id = :userId OR receiver_id = :userId ORDER BY id',
    );
    expect(sentQuery('FROM disputes d')).toContain(
      'JOIN contracts c ON c.id = d.contract_id WHERE c.client_id = :userId OR c.freelancer_id = :userId ORDER BY d.id',
    );
  });

  it('o que é só do titular é filtrado pela coluna do dono', async () => {
    await buildExport(7);
    expect(sentQuery('FROM users WHERE')).toMatch(/FROM users WHERE id = :userId$/);
    // Depósitos são os pagamentos de recarga do titular; pagamento de contratação não é depósito.
    expect(sentQuery('FROM payments')).toContain(
      "FROM payments WHERE payer_id = :userId AND kind = 'topup' ORDER BY id",
    );
    expect(sentQuery('FROM content_reports')).toContain(
      'FROM content_reports WHERE reporter_id = :userId ORDER BY id',
    );
    expect(sentQuery('FROM content_removals')).toContain(
      'FROM content_removals WHERE owner_id = :userId ORDER BY id',
    );
    for (const table of [
      'profiles_freelancer',
      'profiles_client',
      'lgpd_consents',
      'services',
      'wallets',
      'wallet_transactions',
      'credit_transactions',
      'withdrawals',
      'favorites',
      'saved_searches',
      'notifications',
      'push_subscriptions',
      'user_sessions',
      'audit_logs',
      'email_outbox',
    ]) {
      expect(sentQuery(`FROM ${table} WHERE`)).toContain(`FROM ${table} WHERE user_id = :userId`);
    }
    // As solicitações LGPD do titular: exclusão e exportação, juntas, em ordem de data.
    const requests = sentQuery('FROM data_deletion_requests');
    expect(requests).toContain(
      "SELECT 'exclusao' AS tipo, id, status, reason AS motivo, created_at FROM data_deletion_requests WHERE user_id = :userId UNION ALL",
    );
    expect(requests).toMatch(
      /FROM data_export_requests WHERE user_id = :userId ORDER BY created_at$/,
    );
  });

  it('cada lista sai na ordem em que foi criada (ORDER BY id); perfil e saldo são uma linha só', async () => {
    await buildExport(7);
    for (const table of [
      'lgpd_consents',
      'services',
      'wallet_transactions',
      'credit_transactions',
      'withdrawals',
      'favorites',
      'saved_searches',
      'notifications',
      'push_subscriptions',
      'user_sessions',
      'audit_logs',
      'email_outbox',
    ]) {
      expect(sentQuery(`FROM ${table} WHERE`)).toMatch(
        new RegExp(`FROM ${table} WHERE user_id = :userId ORDER BY id$`),
      );
    }
    for (const table of ['profiles_freelancer', 'profiles_client', 'wallets']) {
      expect(sentQuery(`FROM ${table} WHERE`)).toMatch(
        new RegExp(`FROM ${table} WHERE user_id = :userId$`),
      );
    }
  });

  it('a senha nunca sai: a consulta do titular não pede o hash', async () => {
    await buildExport(7);
    expect(sentQuery('FROM users WHERE')).not.toContain('password');
  });

  /** As colunas pedidas (entre SELECT e FROM) pela consulta achada pelo trecho. */
  const columnsOf = (fragment: string): string[] => {
    const sql = sentQuery(fragment);
    return sql.slice('SELECT '.length, sql.indexOf(' FROM ')).split(', ');
  };
  const expectColumns = (fragment: string, columns: string[]): void => {
    expect(columnsOf(fragment), fragment).toEqual(expect.arrayContaining(columns));
  };

  it('"todos os seus dados": contato, localização, dados bancários e de onde o titular agiu saem na cópia', async () => {
    await buildExport(7);
    expectColumns('FROM users WHERE', ['ulid', 'email', 'phone', 'role', 'status', 'created_at']);
    const profile = ['full_name', 'avatar_url', 'bio', 'city', 'state', 'latitude', 'longitude'];
    expectColumns('FROM profiles_freelancer', [...profile, 'headline']);
    expectColumns('FROM profiles_client', profile);
    // O consentimento sai com a prova de quando e de onde foi dado (RN-071).
    expectColumns('FROM lgpd_consents', [
      'type',
      'version',
      'accepted',
      'ip_address',
      'user_agent',
      'created_at',
    ]);
    expectColumns('FROM withdrawals', [
      'amount',
      'pix_key',
      'bank_name',
      'bank_agency',
      'bank_account',
    ]);
    expectColumns('FROM messages m', ['m.sender_id', 'm.content', 'm.file_name', 'm.created_at']);
    expectColumns('FROM reviews WHERE', ['reviewer_id', 'reviewee_id', 'rating', 'comment']);
    expectColumns('FROM wallets WHERE', ['balance', 'balance_pending', 'credits_balance']);
    // Os "técnicos" que a política declara (ADR 54).
    expectColumns('FROM user_sessions', ['ip_address', 'user_agent', 'created_at', 'revoked_at']);
    expectColumns('FROM audit_logs', [
      'action',
      'entity_type',
      'entity_id',
      'ip_address',
      'user_agent',
    ]);
    expectColumns('FROM email_outbox', ['to_email', 'subject', 'template', 'text_body', 'sent_at']);
  });

  it('o que cada versão do formato acrescentou continua saindo (ADR 37, 41, 42, 44 e 46)', async () => {
    await buildExport(7);
    // 1.1: as buscas salvas, com a frequência do alerta (ADR 37).
    expectColumns('FROM saved_searches', [
      'name',
      'query',
      'filters',
      'alert_enabled',
      'alert_frequency',
    ]);
    // 1.2 e 1.4: o que a moderação removeu, com o texto, a contestação e a decisão (ADR 41 e 44).
    expectColumns('FROM content_removals', [
      'target_type',
      'content_snapshot',
      'reason',
      'status',
      'appeal_text',
      'appealed_at',
      'decided_at',
      'decision_note',
    ]);
    // 1.3 e 1.5: a preferência de e-mail, a hora do resumo e o fuso da conta (ADR 42 e 46).
    expectColumns('FROM users WHERE', ['email_frequency', 'digest_hour', 'timezone']);
  });

  it('cada seção do arquivo recebe o resultado da sua consulta; titular, perfis e saldo são a primeira linha', async () => {
    /** Responde cada consulta com linhas que dizem de que tabela vieram. */
    const byTable: [string, Record<string, unknown>[]][] = [
      ['FROM users WHERE', [{ ulid: '01USER', email: 'ana@escambo.test', push_quiet_pass: null }]],
      ['FROM profiles_freelancer', [{ full_name: 'Ana Freela' }]],
      ['FROM profiles_client', [{ full_name: 'Ana Cliente' }]],
      ['FROM lgpd_consents', [{ t: 'consents' }]],
      ['FROM services', [{ t: 'services' }]],
      ['FROM contracts WHERE', [{ t: 'contracts' }]],
      ['FROM contract_status_history', [{ t: 'history' }]],
      ['FROM messages m', [{ t: 'messages' }]],
      ['FROM reviews WHERE', [{ t: 'reviews' }]],
      ['FROM barter_agreements', [{ t: 'barters' }]],
      ['FROM wallets WHERE', [{ balance: '10.00' }]],
      ['FROM wallet_transactions', [{ t: 'walletTx' }]],
      ['FROM credit_transactions', [{ t: 'creditTx' }]],
      ['FROM payments', [{ t: 'deposits' }]],
      ['FROM withdrawals', [{ t: 'withdrawals' }]],
      ['FROM disputes d', [{ t: 'disputes' }]],
      ['FROM content_reports', [{ t: 'reports' }]],
      ['FROM content_removals', [{ t: 'moderation' }]],
      ['FROM favorites', [{ t: 'favorites' }]],
      ['FROM saved_searches', [{ t: 'savedSearches' }]],
      ['FROM notifications', [{ t: 'notifications' }]],
      ['FROM push_subscriptions', [{ t: 'push' }]],
      ['FROM user_sessions', [{ t: 'sessions' }]],
      ['FROM audit_logs', [{ t: 'securityLog' }]],
      ['FROM email_outbox', [{ t: 'emails' }]],
      ['FROM data_deletion_requests', [{ t: 'lgpdRequests' }]],
    ];
    query.mockImplementation((async (sql: string) => {
      const flat = sql.replace(/\s+/g, ' ');
      const hit = byTable.find(([fragment]) => flat.includes(fragment));
      return [hit ? hit[1] : [], []];
    }) as never);
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T12:00:00.000Z') });

    let out: Record<string, unknown>;
    try {
      out = await buildExport(7);
    } finally {
      vi.useRealTimers();
    }

    expect(out).toEqual({
      formato: 'escambo-export/1.7',
      exportadoEm: '2026-10-01T12:00:00.000Z',
      titular: { id: 7, ulid: '01USER', email: 'ana@escambo.test', push_quiet_pass: null },
      perfis: { freelancer: { full_name: 'Ana Freela' }, cliente: { full_name: 'Ana Cliente' } },
      consentimentos: [{ t: 'consents' }],
      servicos: [{ t: 'services' }],
      contratacoes: [{ t: 'contracts' }],
      historicoDeContratacoes: [{ t: 'history' }],
      mensagens: [{ t: 'messages' }],
      avaliacoes: [{ t: 'reviews' }],
      trocas: [{ t: 'barters' }],
      carteira: {
        saldo: { balance: '10.00' },
        extratoReais: [{ t: 'walletTx' }],
        extratoCreditos: [{ t: 'creditTx' }],
        depositos: [{ t: 'deposits' }],
        saques: [{ t: 'withdrawals' }],
      },
      disputas: [{ t: 'disputes' }],
      denunciasFeitas: [{ t: 'reports' }],
      moderacao: [{ t: 'moderation' }],
      favoritos: [{ t: 'favorites' }],
      buscasSalvas: [{ t: 'savedSearches' }],
      notificacoes: [{ t: 'notifications' }],
      avisosNoNavegador: [{ t: 'push' }],
      sessoes: [{ t: 'sessions' }],
      registrosDeSeguranca: [{ t: 'securityLog' }],
      emailsEnviados: [{ t: 'emails' }],
      solicitacoesLgpd: [{ t: 'lgpdRequests' }],
    });
  });

  it('quem não tem perfil nem carteira sai com null nessas seções, e o titular ao menos com o id', async () => {
    const out = (await buildExport(7)) as {
      titular: unknown;
      perfis: unknown;
      carteira: { saldo: unknown };
    };
    expect(out.titular).toEqual({ id: 7, push_quiet_pass: null });
    expect(out.perfis).toEqual({ freelancer: null, cliente: null });
    expect(out.carteira.saldo).toBeNull();
  });

  it('se uma consulta falha, a exportação inteira falha (nada de cópia pela metade)', async () => {
    const boom = new Error('banco fora');
    query.mockImplementation((async (sql: string) => {
      if (sql.includes('FROM wallets')) throw boom;
      return [[], []];
    }) as never);
    await expect(buildExport(7)).rejects.toBe(boom);
  });
});

/**
 * O arquivo da cópia em DATA_DIR/exports, num diretório temporário de verdade: onde é gravado,
 * que nenhum nome sai da pasta, e o que acontece quando o arquivo já não está lá.
 */
describe('arquivos da exportação (DATA_DIR/exports)', () => {
  const originalDataDir = env.DATA_DIR;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'escambo-lgpd-export-'));
    env.DATA_DIR = dir;
  });
  afterEach(async () => {
    env.DATA_DIR = originalDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  const exportsDir = (): string => path.join(dir, 'exports');

  it('o caminho é sempre dentro de DATA_DIR/exports, mesmo que o nome guardado tente sair da pasta', () => {
    expect(exportFilePath('01USER-7.json')).toBe(path.join(exportsDir(), '01USER-7.json'));
    expect(exportFilePath('../../segredo.env')).toBe(path.join(exportsDir(), 'segredo.env'));
    expect(exportFilePath('/etc/passwd')).toBe(path.join(exportsDir(), 'passwd'));
    expect(exportFilePath('sub/pasta/x.json')).toBe(path.join(exportsDir(), 'x.json'));
  });

  it('grava o JSON legível (indentado), cria a pasta se preciso e devolve o tamanho em bytes', async () => {
    const data = { titular: { id: 7, nome: 'João Conceição' }, servicos: [] };
    expect(existsSync(exportsDir())).toBe(false);

    const bytes = await writeExportFile('01USER-7.json', data);

    const body = await readFile(path.join(exportsDir(), '01USER-7.json'), 'utf8');
    expect(body).toBe(JSON.stringify(data, null, 2));
    expect(JSON.parse(body)).toEqual(data);
    // Bytes em UTF-8, não caracteres: os acentos ocupam dois.
    expect(bytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(bytes).toBe(body.length + 3);
  });

  it('gravar com um nome que tenta sair da pasta deixa o arquivo dentro dela', async () => {
    await writeExportFile('../fora.json', { a: 1 });
    expect(await readdir(exportsDir())).toEqual(['fora.json']);
    expect(existsSync(path.join(dir, 'fora.json'))).toBe(false);
  });

  it('gravar de novo com o mesmo nome substitui o conteúdo', async () => {
    await writeExportFile('a.json', { versao: 1, sobra: 'x'.repeat(50) });
    await writeExportFile('a.json', { versao: 2 });
    expect(JSON.parse(await readFile(path.join(exportsDir(), 'a.json'), 'utf8'))).toEqual({
      versao: 2,
    });
  });

  it('exportFileExists diz se o arquivo está no disco (é o que decide o 410 do download)', async () => {
    expect(await exportFileExists('a.json')).toBe(false);
    await writeExportFile('a.json', {});
    expect(await exportFileExists('a.json')).toBe(true);
    expect(await exportFileExists('b.json')).toBe(false);
    // Um arquivo fora de exports com o mesmo nome não conta.
    await writeFile(path.join(dir, 'c.json'), '{}');
    expect(await exportFileExists('../c.json')).toBe(false);
  });

  it('openExportFile entrega o conteúdo gravado, byte a byte', async () => {
    const data = { titular: { id: 7, nome: 'Ação' } };
    await writeExportFile('a.json', data);

    const chunks: Buffer[] = [];
    for await (const chunk of openExportFile('a.json')) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks).toString('utf8')).toBe(JSON.stringify(data, null, 2));
  });

  it('deleteExportFile apaga só o arquivo pedido', async () => {
    await writeExportFile('a.json', {});
    await writeExportFile('b.json', {});

    expect(await deleteExportFile('a.json')).toBeUndefined();

    expect(await readdir(exportsDir())).toEqual(['b.json']);
  });

  it('apagar o que já não existe (nem a pasta) não é erro: o job de expiração segue em frente', async () => {
    await expect(deleteExportFile('nunca-existiu.json')).resolves.toBeUndefined();
    expect(existsSync(exportsDir())).toBe(false);
  });
});
