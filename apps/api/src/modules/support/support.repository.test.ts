import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { clock, setClockForTests } from '../../utils/clock';
import {
  supportRepository as repo,
  supportSlaDue,
  type SupportTicketRow,
} from './support.repository';
const { persist } = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../notifications/notifications.service', () => ({ notificationsService: { persist } }));
const NOW = new Date('2026-10-15T15:00:00Z');
const OK = { affectedRows: 1 };
const owner = { id: 7, role: 'client', status: 'suspended', deleted_at: null };
const admin = { id: 90, role: 'admin', status: 'active', deleted_at: null };
const input = {
  category: 'account' as const,
  subject: 'Minha conta',
  description: 'Preciso de atendimento',
};
const ticket = (extra: Record<string, unknown> = {}) =>
  ({
    id: 12,
    ulid: '01JA0000000000000000000000',
    user_id: 7,
    contract_id: null,
    category: 'account',
    subject: 'Privado',
    status: 'open',
    priority: 'medium',
    assigned_to: null,
    first_response_at: null,
    sla_due_at: NOW,
    sla_alerted_at: null,
    resolved_at: null,
    closed_at: null,
    created_at: new Date('2026-10-14T15:00:00Z'),
    updated_at: NOW,
    ...extra,
  }) as SupportTicketRow;
function locked(extra: Record<string, unknown> = {}, isAdmin = false) {
  fakeDb.reply([{ user_id: 7 }], [owner]);
  if (isAdmin) fakeDb.reply([admin]);
  fakeDb.reply([ticket(extra)]);
}
beforeEach(() => {
  fakeDb.reset();
  vi.clearAllMocks();
  persist.mockResolvedValue({ userId: 90, id: 99, params: {} });
  setClockForTests(NOW, { frozen: true });
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

describe('abertura serializada por titular', () => {
  it('conta suspensa abre e limite só lê depois da trava, na mesma transação', async () => {
    fakeDb.reply([owner], [], [{ total: 2 }], { insertId: 12 }, OK);
    expect(await repo.create(7, input)).toBe(12);
    expect(fakeDb.sqls()[0]).toContain('FROM users WHERE id = :uid FOR UPDATE');
    expect(fakeDb.sqls()[1]).toContain("status <> 'closed'");
    expect(fakeDb.sqls()[1]).toContain('contract_id <=> :contractId AND TRIM(subject) = :subject');
    expect(fakeDb.calls[3]!.params).toMatchObject({
      due: new Date('2026-10-16T15:00:00Z'),
      uid: 7,
      contractId: null,
    });
    expect(fakeDb.calls[4]!.params).toMatchObject({
      message: input.description,
      internal: 0,
      now: NOW,
    });
    expect(fakeDb.conn.commit).toHaveBeenCalledOnce();
  });
  it('vínculo verifica participante com shared lock antes de users sem snapshot anterior', async () => {
    fakeDb.reply(
      [{ client_id: 7, freelancer_id: 8 }],
      [owner],
      [],
      [{ total: 0 }],
      { insertId: 12 },
      OK,
    );
    await repo.create(7, { ...input, contractId: 31 });
    expect(fakeDb.sqls()[0]).toContain('FROM contracts WHERE id = :contractId FOR SHARE');
    expect(fakeDb.sqls()[1]).toContain('FROM users WHERE id = :uid FOR UPDATE');
    expect(fakeDb.sqls().join(' ')).not.toMatch(/UPDATE contracts|disputes|wallet|escrow|credits/i);
  });
  it.each([{ rows: [] }, { rows: [{ client_id: 8, freelancer_id: 9 }] }])(
    'fora da contratação não descobre nem trava contas: %j',
    async ({ rows }) => {
      fakeDb.reply(rows);
      await expect(repo.create(7, { ...input, contractId: 31 })).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(fakeDb.calls).toHaveLength(1);
    },
  );
  it('duplicidade tem erro próprio e inclui resolved no limite', async () => {
    fakeDb.reply([owner], [{ id: 10 }]);
    await expect(repo.create(7, input)).rejects.toMatchObject({ code: 'ticket_duplicate' });
    expect(fakeDb.sqls().some((sql) => sql.startsWith('INSERT'))).toBe(false);
    fakeDb.reset();
    fakeDb.reply([owner], [], [{ total: '3' }]);
    await expect(repo.create(7, input)).rejects.toMatchObject({ code: 'ticket_limit' });
    expect(fakeDb.sqls()[2]).toContain("status <> 'closed'");
  });
  it.each([
    { accounts: [] },
    { accounts: [{ ...owner, deleted_at: NOW }] },
    { accounts: [{ ...owner, status: 'banned' }] },
  ])('não repõe texto após exclusão ou banimento: %j', async ({ accounts }) => {
    fakeDb.reply(accounts);
    await expect(repo.create(7, input)).rejects.toBeInstanceOf(Error);
    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.conn.rollback).toHaveBeenCalledOnce();
  });
  it('falha ao gravar descrição reverte ticket', async () => {
    fakeDb.reply([owner], [], [{ total: 0 }], { insertId: 12 }, new Error('falhou'));
    await expect(repo.create(7, input)).rejects.toMatchObject({ code: 'support_unavailable' });
    expect(fakeDb.conn.commit).not.toHaveBeenCalled();
    expect(fakeDb.conn.rollback).toHaveBeenCalledOnce();
  });
});
describe('conversa, estado e ordem de travas LGPD', () => {
  it('lista e detalhe preservam dono e sinalizam anonimização sem JOIN expansivo', async () => {
    fakeDb.reply([ticket({ owner_deleted: 1 })]);
    expect((await repo.list(7, { page: 3, limit: 20, status: 'resolved' }))[0]!.owner_deleted).toBe(
      1,
    );
    expect(fakeDb.calls[0]!.params).toMatchObject({
      uid: 7,
      offset: 40,
      limit: 20,
      status: 'resolved',
    });
    expect(fakeDb.sqls()[0]).toContain('AS owner_deleted');
    expect(fakeDb.sqls()[0]).toContain('AND status = :status');
    fakeDb.reset();
    fakeDb.reply([]);
    expect(await repo.find(12, 8)).toBeUndefined();
    expect(fakeDb.calls[0]!.params).toEqual({ id: 12, uid: 8 });
    expect(fakeDb.sqls()[0]).toContain('(:uid IS NULL OR user_id = :uid)');
  });
  it('admin recipients excluem deletados e suspensos na consulta atual', async () => {
    fakeDb.reply([{ id: 90 }]);
    expect(await repo.activeAdmins()).toEqual([90]);
    expect(fakeDb.sqls()[0]).toContain(
      "role = 'admin' AND status = 'active' AND deleted_at IS NULL",
    );
  });
  it('público filtra internas no SQL antes de limitar, com cursor exclusivo', async () => {
    fakeDb.reply([]);
    await repo.messages(12, false, 20);
    expect(fakeDb.sqls()[0]).toMatch(/is_internal = 0.*id < :beforeId.*ORDER BY id DESC LIMIT 51/);
    expect(fakeDb.calls[0]!.params).toEqual({ id: 12, beforeId: 20 });
    fakeDb.reset();
    fakeDb.reply([]);
    await repo.messages(12, true);
    expect(fakeDb.sqls()[0]).not.toContain('is_internal = 0');
  });
  it('resposta pública administrativa trava users em ordem antes do ticket e inicia SLA uma vez', async () => {
    locked({}, true);
    fakeDb.reply(OK, OK);
    const readClock = vi.spyOn(clock, 'now');
    expect(await repo.reply(12, 90, true, { message: 'Resposta' })).toBe(true);
    expect(fakeDb.sqls().slice(1, 4)).toEqual([
      'SELECT id, role, status, deleted_at FROM users WHERE id = :uid FOR UPDATE',
      'SELECT id, role, status, deleted_at FROM users WHERE id = :uid FOR UPDATE',
      'SELECT * FROM support_tickets WHERE id = :id FOR UPDATE',
    ]);
    expect(fakeDb.calls.slice(1, 3).map((c) => c.params)).toEqual([{ uid: 7 }, { uid: 90 }]);
    expect(readClock.mock.invocationCallOrder[0]).toBeGreaterThan(
      fakeDb.conn.query.mock.invocationCallOrder[3]!,
    );
    expect(fakeDb.sqls().at(-1)).toContain('COALESCE(first_response_at, :now)');
    expect(fakeDb.calls.at(-1)!.params).toMatchObject({ status: 'waiting_user', resolvedAt: null });
  });
  it('ordem numérica vale mesmo se admin tem id menor que titular', async () => {
    fakeDb.reply([{ user_id: 7 }], [{ ...admin, id: 2 }], [owner], [ticket()], OK, OK);
    await repo.reply(12, 2, true, { message: 'Resposta' });
    expect(fakeDb.calls.slice(1, 3).map((c) => c.params)).toEqual([{ uid: 2 }, { uid: 7 }]);
  });
  it('nota interna não altera estado, responsável, resolução nem primeira resposta', async () => {
    locked({ status: 'resolved', resolved_at: NOW }, true);
    fakeDb.reply(OK);
    expect(await repo.reply(12, 90, true, { message: 'Nota privada', internal: true })).toBe(true);
    expect(fakeDb.sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
    expect(fakeDb.calls.at(-1)!.params).toMatchObject({ internal: 1 });
  });
  it('resolução é mensagem pública com data de resolução', async () => {
    locked({}, true);
    fakeDb.reply(OK, OK);
    await repo.reply(12, 90, true, { message: 'Resolvido', resolve: true });
    expect(fakeDb.calls.at(-1)!.params).toMatchObject({ status: 'resolved', resolvedAt: NOW });
  });
  it('titular responde antes de cinco dias, reabre e limpa resolução', async () => {
    locked({ status: 'resolved', resolved_at: new Date(NOW.getTime() - 5 * 86_400_000 + 1000) });
    fakeDb.reply(OK, OK);
    await repo.reply(12, 7, false, { message: 'Ainda preciso' });
    expect(fakeDb.sqls().at(-1)).toContain("status = 'in_progress', resolved_at = NULL");
    expect(fakeDb.sqls().join(' ')).not.toContain('first_response_at =');
  });
  it('na fronteira de cinco dias COMMIT do fechamento ocorre antes de recusar mensagem', async () => {
    locked({ status: 'resolved', resolved_at: new Date(NOW.getTime() - 5 * 86_400_000) });
    fakeDb.reply(OK);
    expect(await repo.reply(12, 7, false, { message: 'Já venceu' })).toBe(false);
    expect(fakeDb.conn.commit).toHaveBeenCalledOnce();
    expect(fakeDb.sqls().some((s) => s.startsWith('INSERT'))).toBe(false);
    expect(fakeDb.sqls().at(-1)).toContain("status = 'closed'");
  });
  it('closed é terminal e outro dono recebe 404', async () => {
    locked({ status: 'closed' });
    await expect(repo.reply(12, 7, false, { message: 'Oi' })).rejects.toMatchObject({
      code: 'ticket_closed',
    });
    fakeDb.reset();
    fakeDb.reply([{ user_id: 8 }]);
    await expect(repo.reply(12, 7, false, { message: 'Oi' })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(fakeDb.calls).toHaveLength(1);
  });
  it('owner apagado sob trava impede admin de repor texto', async () => {
    fakeDb.reply([{ user_id: 7 }], [{ ...owner, deleted_at: NOW }], [admin]);
    await expect(repo.reply(12, 90, true, { message: 'Privado' })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(fakeDb.calls).toHaveLength(3);
  });
  it.each([{ role: 'client' }, { status: 'suspended' }, { deleted_at: NOW }])(
    'admin desautorizado sob trava não escreve: %j',
    async (extra) => {
      fakeDb.reply([{ user_id: 7 }], [owner], [{ ...admin, ...extra }]);
      await expect(repo.reply(12, 90, true, { message: 'Privado' })).rejects.toBeInstanceOf(Error);
      expect(fakeDb.sqls().some((s) => /INSERT|UPDATE support/.test(s))).toBe(false);
    },
  );
  it('fechar é idempotente e não precisa esperar resolução', async () => {
    locked();
    fakeDb.reply(OK);
    await repo.close(12, 7);
    expect(fakeDb.sqls().at(-1)).toContain("status = 'closed'");
    fakeDb.reset();
    locked({ status: 'closed' });
    await repo.close(12, 7);
    expect(fakeDb.sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
  });
  it('prioridade recalcula SLA desde criação e PATCH não reabre resolved', async () => {
    locked({}, true);
    fakeDb.reply(OK);
    await repo.update(12, 90, { priority: 'critical' });
    expect(fakeDb.calls.at(-1)!.params).toMatchObject({
      due: new Date('2026-10-14T17:00:00Z'),
      priority: 'critical',
    });
    fakeDb.reset();
    locked({ status: 'resolved' }, true);
    await expect(repo.update(12, 90, { status: 'in_progress' })).rejects.toMatchObject({
      code: 'ticket_reply_required',
    });
  });
});
describe('SLA durável e encerramento', () => {
  it('titular deletado não sofre mutações pelo job, mesmo com resolução vencida', async () => {
    fakeDb.reply(
      [{ user_id: 7 }],
      [{ ...owner, deleted_at: NOW }],
      [ticket({ status: 'resolved', resolved_at: new Date(NOW.getTime() - 6 * 86_400_000) })],
    );
    expect(await repo.maintain(12, [])).toEqual({ alerted: false, closed: false, notices: [] });
    expect(fakeDb.sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });
  it('erros de SQL não propagam texto privado ao error-handler global', async () => {
    const secretError = Object.assign(new Error('SQL com TEXTO PRIVADO'), {
      sql: "INSERT VALUES ('TEXTO PRIVADO')",
    });
    fakeDb.reply([owner], [], [{ total: 0 }], secretError);
    let caught: unknown;
    try {
      await repo.create(7, input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'support_unavailable', statusCode: 503 });
    expect(JSON.stringify(caught)).not.toContain('TEXTO PRIVADO');
    expect(String(caught)).not.toContain('TEXTO PRIVADO');
  });
  it.each([
    ['low', 72],
    ['medium', 24],
    ['high', 8],
    ['critical', 2],
  ] as const)('prioridade %s dura %i horas corridas', (priority, hours) => {
    expect(supportSlaDue(NOW, priority).getTime()).toBe(NOW.getTime() + hours * 3_600_000);
  });
  it('sem admin ativo não marca alerta entregue', async () => {
    locked();
    expect(await repo.maintain(12, [])).toEqual({ alerted: false, closed: false, notices: [] });
    expect(persist).not.toHaveBeenCalled();
    expect(fakeDb.sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
  });
  it('alerta com metadados genéricos e marcador são atômicos', async () => {
    locked({}, true);
    fakeDb.reply(OK);
    const result = await repo.maintain(12, [90, 90]);
    expect(result.alerted).toBe(true);
    expect(result.notices).toHaveLength(1);
    expect(persist).toHaveBeenCalledWith(
      90,
      {
        type: 'support_sla',
        title: 'Chamado aguardando primeira resposta',
        body: 'O prazo de primeira resposta de um chamado foi atingido.',
        data: { supportTicketId: 12, supportAdmin: true },
      },
      fakeDb.conn,
    );
    expect(fakeDb.sqls().at(-1)).toBe(
      'UPDATE support_tickets SET sla_alerted_at = :now WHERE id = :id',
    );
    expect(fakeDb.conn.commit).toHaveBeenCalledOnce();
  });
  it('falha de persistência desfaz marcador para tentar novamente', async () => {
    locked({}, true);
    persist.mockRejectedValueOnce(new Error('falha'));
    await expect(repo.maintain(12, [90])).rejects.toMatchObject({ code: 'support_unavailable' });
    expect(fakeDb.conn.rollback).toHaveBeenCalledOnce();
    expect(fakeDb.conn.commit).not.toHaveBeenCalled();
    expect(fakeDb.sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
  });
  it.each([
    { first_response_at: NOW },
    { sla_alerted_at: NOW },
    { sla_due_at: new Date(NOW.getTime() + 1000) },
    { status: 'closed' },
  ])('rechecagem sob lock elimina alerta indevido: %j', async (extra) => {
    locked(extra, true);
    expect((await repo.maintain(12, [90])).alerted).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });
  it('job fecha resolved no limite sem aviso financeiro', async () => {
    locked({ status: 'resolved', resolved_at: new Date(NOW.getTime() - 5 * 86_400_000) });
    fakeDb.reply(OK);
    expect(await repo.maintain(12, [])).toEqual({ alerted: false, closed: true, notices: [] });
    expect(persist).not.toHaveBeenCalled();
    expect(fakeDb.sqls().join(' ')).not.toMatch(/wallet|escrow|credits|UPDATE contracts/);
  });
  it('seleção de manutenção prioriza encerramentos e não deixa contas apagadas obstruírem SLA', async () => {
    fakeDb.reply([{ id: 12 }]);
    expect(await repo.maintenanceCandidates(9999)).toEqual([12]);
    expect(fakeDb.calls[0]!.params).toMatchObject({ limit: 500 });
    expect(fakeDb.sqls()[0]).toContain('u.deleted_at IS NULL');
    expect(fakeDb.sqls()[0]).toContain('THEN 0 ELSE 1 END');
  });
  it('avisos respeitam conta atual e persistem com trava LGPD', async () => {
    fakeDb.reply([{ ...owner, deleted_at: NOW }]);
    expect(await repo.saveNotice(7, { type: 'support_reply', title: 'Aviso' }, false)).toBeNull();
    expect(persist).not.toHaveBeenCalled();
    fakeDb.reset();
    fakeDb.reply([admin]);
    await repo.saveNotice(90, { type: 'support_opened', title: 'Aviso' }, true);
    expect(persist).toHaveBeenCalledWith(
      90,
      { type: 'support_opened', title: 'Aviso' },
      fakeDb.conn,
    );
  });
});
