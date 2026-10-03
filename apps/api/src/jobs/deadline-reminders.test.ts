import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../config/logger';
import { deadlineRemindersService } from '../modules/contracts/deadline-reminders.service';
import {
  remindersRepository,
  type ReminderCandidate,
} from '../modules/contracts/reminders.repository';
import type { ReminderKind } from '../modules/contracts/reminders-sql';
import { settingsRepository } from '../modules/settings/settings.repository';
import { setClockForTests } from '../utils/clock';
import { runDeadlineReminders } from './deadline-reminders';

vi.mock('../modules/contracts/reminders.repository', () => ({
  remindersRepository: { candidates: vi.fn() },
}));
vi.mock('../modules/contracts/deadline-reminders.service', () => ({
  deadlineRemindersService: {
    proposal: vi.fn(),
    delivery: vi.fn(),
    approval: vi.fn(),
    milestoneApprovals: vi.fn(),
    extension: vi.fn(),
    revisionStalled: vi.fn(),
    milestoneRevisionStalled: vi.fn(),
  },
}));
vi.mock('../modules/settings/settings.repository', () => ({
  settingsRepository: { getNumber: vi.fn() },
}));

const repo = vi.mocked(remindersRepository);
const svc = vi.mocked(deadlineRemindersService);
const settings = vi.mocked(settingsRepository);

/** qui, 01/10/2026 às 12:00 em Brasília: dia nos 5 fusos (10:00 em Rio Branco). */
const NOON = new Date('2026-10-01T15:00:00.000Z');
/** 00:00 em Brasília: noite nos 5 fusos. */
const MIDNIGHT = new Date('2026-10-02T03:00:00.000Z');
/** 09:30 em Brasília e 07:30 em Rio Branco. */
const EARLY = new Date('2026-10-01T12:30:00.000Z');
const ALL_ZONES = [
  'America/Noronha',
  'America/Sao_Paulo',
  'America/Cuiaba',
  'America/Manaus',
  'America/Rio_Branco',
];

/** Vence sex, 02/10 às 12:00 de Brasília: o slot (qui, 01/10 às 09:00) já chegou ao meio-dia. */
const READY_DUE = new Date('2026-10-02T15:00:00.000Z');
/** Vence sáb, 03/10 às 09:00 de Brasília: o slot é sex, 02/10 às 09:00, ainda por vir. */
const FUTURE_DUE = new Date('2026-10-03T12:00:00.000Z');
const FIRST_PAGE = { due: new Date(0), id: 0 };

/** As colunas da linha, opcionais, sem a assinatura de índice nem o `constructor` do RowDataPacket. */
type Columns<T> = {
  [
    K in keyof T as string extends K
      ? never
      : number extends K
        ? never
        : K extends 'constructor'
          ? never
          : K
  ]?: T[K];
};

function cand(over: Columns<ReminderCandidate> = {}): ReminderCandidate {
  return {
    contract_id: 7,
    entity_id: 7,
    due_at: READY_DUE,
    seq: 0,
    start_at: null,
    client_id: 1,
    freelancer_id: 2,
    client_timezone: 'America/Sao_Paulo',
    freelancer_timezone: 'America/Sao_Paulo',
    ...over,
  } as unknown as ReminderCandidate;
}

/** As páginas que o livro devolve por tipo, na ordem em que são pedidas (depois, vazio). */
function serve(pages: Partial<Record<ReminderKind, ReminderCandidate[][]>>): void {
  repo.candidates.mockImplementation(async (kind) => pages[kind]?.shift() ?? []);
}

const kindsAsked = (): ReminderKind[] => repo.candidates.mock.calls.map(([kind]) => kind);

const NOTHING_SENT = {
  proposal: [],
  delivery: [],
  approval: [],
  milestone_approval: [],
  extension: [],
  revision: [],
  milestone_revision: [],
};

/**
 * Job dos lembretes (ADR 58) com o livro e o envio simulados: o que consulta, em que ordem, o que
 * espera o slot, o que sai e como agrupa os marcos. O slot e o portão são as contas puras de
 * human-hours, com o fuso de quem recebe.
 */
describe('job dos lembretes de prazo (ADR 58)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serve({});
    settings.getNumber.mockResolvedValue(12);
    svc.proposal.mockResolvedValue(true);
    svc.delivery.mockResolvedValue(true);
    svc.approval.mockResolvedValue(true);
    svc.extension.mockResolvedValue(true);
    svc.revisionStalled.mockResolvedValue(true);
    svc.milestoneRevisionStalled.mockResolvedValue(true);
    svc.milestoneApprovals.mockImplementation(async (_id, rows) => rows.map((r) => r.entity_id));
  });
  afterEach(() => {
    setClockForTests(null);
    vi.restoreAllMocks();
  });

  it('de noite em todos os fusos não consulta nada nem envia', async () => {
    const result = await runDeadlineReminders(MIDNIGHT);

    expect(result).toEqual({ zones: [], sent: NOTHING_SENT, waiting: 0, lost: 0, failed: [] });
    expect(repo.candidates).not.toHaveBeenCalled();
    expect(settings.getNumber).not.toHaveBeenCalled();
  });

  it('percorre os lembretes antes do vencimento e depois as revisões paradas, cada um desde o começo da fila, com os fusos de dia', async () => {
    const result = await runDeadlineReminders(NOON);

    expect(result).toEqual({
      zones: ALL_ZONES,
      sent: NOTHING_SENT,
      waiting: 0,
      lost: 0,
      failed: [],
    });
    expect(kindsAsked()).toEqual([
      'proposal',
      'delivery',
      'approval',
      'milestone_approval',
      'extension',
      'revision',
      'milestone_revision',
    ]);
    for (const [, p] of repo.candidates.mock.calls) {
      expect(p).toEqual({ now: NOON, zones: ALL_ZONES, after: FIRST_PAGE });
    }
  });

  it('cada tipo vai ao seu envio, com o instante da rodada', async () => {
    const p = cand({ contract_id: 1, entity_id: 1 });
    const a = cand({ contract_id: 3, entity_id: 3 });
    const x = cand({ contract_id: 5, entity_id: 5, seq: 2 });
    serve({ proposal: [[p]], approval: [[a]], extension: [[x]] });

    const result = await runDeadlineReminders(NOON);

    expect(svc.proposal.mock.calls).toEqual([[p, NOON]]);
    expect(svc.approval.mock.calls).toEqual([[a, NOON]]);
    expect(svc.extension.mock.calls).toEqual([[x, NOON]]);
    expect(svc.delivery).not.toHaveBeenCalled();
    expect(result.sent).toEqual({ ...NOTHING_SENT, proposal: [1], approval: [3], extension: [5] });
  });

  it('o slot que ainda não chegou conta em "esperando" e não envia', async () => {
    serve({
      proposal: [[cand({ contract_id: 1, entity_id: 1, due_at: FUTURE_DUE })]],
      // Aceite há 13 h: a véspera (hoje às 9h) não tem 12 h de aviso, e o slot passa para amanhã.
      delivery: [
        [
          cand({
            contract_id: 2,
            entity_id: 2,
            due_at: new Date('2026-10-02T16:00:00.000Z'),
            start_at: new Date('2026-10-01T02:00:00.000Z'),
          }),
        ],
      ],
    });

    const result = await runDeadlineReminders(NOON);

    expect(result.waiting).toBe(2);
    expect(result.sent).toEqual(NOTHING_SENT);
    expect(svc.proposal).not.toHaveBeenCalled();
    expect(svc.delivery).not.toHaveBeenCalled();
  });

  it('o slot e a hora do dia são do fuso de quem recebe (vazio ou fora da lista vale Brasília)', async () => {
    // 09:30 em Brasília e 07:30 em Rio Branco; vence sex, 02/10 às 09:00 de Brasília.
    const due = new Date('2026-10-02T12:00:00.000Z');
    const toRioBranco = cand({
      contract_id: 1,
      entity_id: 1,
      due_at: due,
      freelancer_timezone: 'America/Rio_Branco',
    });
    const toBrasilia = cand({
      contract_id: 2,
      entity_id: 2,
      due_at: due,
      client_timezone: 'America/Rio_Branco',
    });
    const noZone = cand({ contract_id: 3, entity_id: 3, due_at: due, freelancer_timezone: null });
    const clientInRioBranco = cand({
      contract_id: 4,
      entity_id: 4,
      due_at: due,
      client_timezone: 'America/Rio_Branco',
    });
    const clientAbroad = cand({
      contract_id: 5,
      entity_id: 5,
      due_at: due,
      client_timezone: 'Europe/Lisbon',
      freelancer_timezone: 'America/Rio_Branco',
    });
    serve({
      proposal: [[toRioBranco, toBrasilia, noZone]],
      approval: [[clientInRioBranco, clientAbroad]],
    });

    const result = await runDeadlineReminders(EARLY);

    expect(result.zones).toEqual(['America/Noronha', 'America/Sao_Paulo']);
    expect(result.sent).toEqual({ ...NOTHING_SENT, proposal: [2, 3], approval: [5] });
    expect(result.waiting).toBe(2);
  });

  it('uma página cheia de linhas que não podem sair não prende a fila: pede a 2ª página pelo cursor e envia a que está pronta', async () => {
    // 200 linhas de quem foi avisado há 13 h: o slot delas é amanhã às 9h.
    const stuck = Array.from({ length: 200 }, (_, i) =>
      cand({
        contract_id: i + 1,
        entity_id: i + 1,
        due_at: new Date('2026-10-02T16:00:00.000Z'),
        start_at: new Date('2026-10-01T02:00:00.000Z'),
      }),
    );
    const ready = cand({
      contract_id: 201,
      entity_id: 201,
      due_at: new Date('2026-10-02T17:00:00.000Z'),
      start_at: new Date('2026-09-29T15:00:00.000Z'),
    });
    serve({ proposal: [stuck, [ready]] });

    const result = await runDeadlineReminders(NOON);

    const asked = repo.candidates.mock.calls.filter(([kind]) => kind === 'proposal');
    expect(asked.map(([, p]) => p.after)).toEqual([
      FIRST_PAGE,
      { due: new Date('2026-10-02T16:00:00.000Z'), id: 200 },
    ]);
    expect(svc.proposal.mock.calls).toEqual([[ready, NOON]]);
    expect(result.sent.proposal).toEqual([201]);
    expect(result.waiting).toBe(200);
  });

  it('para no teto de 25 páginas por tipo, avisa no log e segue com os outros tipos', async () => {
    const warn = vi.spyOn(logger, 'warn');
    let n = 0;
    const fullPage = (): ReminderCandidate[] =>
      Array.from({ length: 200 }, () => {
        n++;
        return cand({ contract_id: n, entity_id: n, due_at: FUTURE_DUE });
      });
    repo.candidates.mockImplementation(async (kind) => (kind === 'proposal' ? fullPage() : []));

    const result = await runDeadlineReminders(NOON);

    expect(kindsAsked().filter((k) => k === 'proposal')).toHaveLength(25);
    expect(kindsAsked().slice(25)).toEqual([
      'delivery',
      'approval',
      'milestone_approval',
      'extension',
      'revision',
      'milestone_revision',
    ]);
    expect(result.waiting).toBe(5000);
    expect(warn.mock.calls).toEqual([
      [{ kind: 'proposal' }, 'lembretes: teto de páginas na rodada; o resto fica para a próxima'],
    ]);
  });

  it('os marcos prontos da mesma contratação vão juntos num envio só; o que espera o slot fica de fora', async () => {
    const m31 = cand({ contract_id: 7, entity_id: 31 });
    const m41 = cand({ contract_id: 8, entity_id: 41 });
    const m32 = cand({ contract_id: 7, entity_id: 32 });
    const m33 = cand({ contract_id: 7, entity_id: 33, due_at: FUTURE_DUE });
    serve({ milestone_approval: [[m31, m41, m32, m33]] });
    svc.milestoneApprovals.mockResolvedValueOnce([31, 32]).mockResolvedValueOnce([]);

    const result = await runDeadlineReminders(NOON);

    expect(svc.milestoneApprovals.mock.calls).toEqual([
      [7, [m31, m32], NOON],
      [8, [m41], NOON],
    ]);
    expect(result.sent.milestone_approval).toEqual([31, 32]);
    // A contratação 8 perdeu a trava: conta como perdida, uma vez.
    expect(result.lost).toBe(1);
    expect(result.waiting).toBe(1);
  });

  it('o marco da mesma contratação que vem na página seguinte entra no mesmo envio', async () => {
    const waiting = Array.from({ length: 199 }, (_, i) =>
      cand({ contract_id: 100 + i, entity_id: 100 + i, due_at: FUTURE_DUE }),
    );
    const m31 = cand({ contract_id: 7, entity_id: 31 });
    const m32 = cand({ contract_id: 7, entity_id: 32 });
    serve({ milestone_approval: [[m31, ...waiting], [m32]] });

    await runDeadlineReminders(NOON);

    expect(svc.milestoneApprovals.mock.calls).toEqual([[7, [m31, m32], NOON]]);
  });

  it('a falha de um envio não derruba a rodada: registra a contratação e segue', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const boom = new Error('SMTP fora');
    const deadlock = new Error('deadlock');
    const locked = new Error('tabela travada');
    svc.proposal.mockRejectedValueOnce(boom).mockResolvedValueOnce(true);
    svc.milestoneApprovals.mockRejectedValueOnce(deadlock);
    svc.revisionStalled.mockRejectedValueOnce(locked);
    serve({
      proposal: [[cand({ contract_id: 1, entity_id: 1 }), cand({ contract_id: 2, entity_id: 2 })]],
      milestone_approval: [[cand({ contract_id: 3, entity_id: 31 })]],
      revision: [[cand({ contract_id: 4, entity_id: 4 })]],
      milestone_revision: [[cand({ contract_id: 5, entity_id: 51 })]],
    });

    const result = await runDeadlineReminders(NOON);

    expect(result.failed).toEqual([1, 3, 4]);
    expect(result.sent).toEqual({ ...NOTHING_SENT, proposal: [2], milestone_revision: [51] });
    // Cada falha diz a contratação e o tipo: o grupo dos marcos é registrado pela contratação.
    expect(warn.mock.calls).toEqual([
      [{ err: boom, contractId: 1, kind: 'proposal' }, 'lembrete falhou'],
      [{ err: deadlock, contractId: 3, kind: 'milestone_approval' }, 'lembrete falhou'],
      [{ err: locked, contractId: 4, kind: 'revision' }, 'lembrete falhou'],
    ]);
  });

  it('envio sem trava ganha conta como perdido', async () => {
    svc.approval.mockResolvedValue(false);
    svc.milestoneRevisionStalled.mockResolvedValue(false);
    serve({
      approval: [[cand({ contract_id: 1, entity_id: 1 })]],
      milestone_revision: [[cand({ contract_id: 2, entity_id: 21 })]],
    });

    const result = await runDeadlineReminders(NOON);

    expect(result).toEqual({
      zones: ALL_ZONES,
      sent: NOTHING_SENT,
      waiting: 0,
      lost: 2,
      failed: [],
    });
  });

  it('a carência vigente é lida uma vez só, e só quando há lembrete de entrega para sair', async () => {
    const d1 = cand({ contract_id: 1, entity_id: 1 });
    const d2 = cand({ contract_id: 2, entity_id: 2 });
    serve({ delivery: [[cand({ contract_id: 9, entity_id: 9, due_at: FUTURE_DUE }), d1, d2]] });

    const result = await runDeadlineReminders(NOON);

    expect(settings.getNumber.mock.calls).toEqual([['deadline_grace_hours', 24]]);
    expect(svc.delivery.mock.calls).toEqual([
      [d1, 12, NOON],
      [d2, 12, NOON],
    ]);
    expect(result.sent.delivery).toEqual([1, 2]);
  });

  it('sem lembrete de entrega para sair, não lê a carência', async () => {
    serve({
      proposal: [[cand({ contract_id: 1, entity_id: 1 })]],
      delivery: [[cand({ contract_id: 2, entity_id: 2, due_at: FUTURE_DUE })]],
    });

    await runDeadlineReminders(NOON);

    expect(settings.getNumber).not.toHaveBeenCalled();
  });

  it('revisão parada sai sem slot: o portão das duas partes já está na consulta', async () => {
    // Pedidos de 8 dias atrás: como lembrete "antes do vencimento" nunca sairiam.
    const r = cand({ contract_id: 4, entity_id: 4, due_at: new Date('2026-09-23T14:00:00.000Z') });
    const m = cand({ contract_id: 5, entity_id: 51, due_at: new Date('2026-09-23T14:00:00.000Z') });
    serve({ revision: [[r]], milestone_revision: [[m]] });

    const result = await runDeadlineReminders(NOON);

    expect(svc.revisionStalled.mock.calls).toEqual([[r, NOON]]);
    expect(svc.milestoneRevisionStalled.mock.calls).toEqual([[m, NOON]]);
    expect(result.sent).toEqual({ ...NOTHING_SENT, revision: [4], milestone_revision: [51] });
    expect(result.waiting).toBe(0);
  });

  it('sem hora informada, usa o relógio do fluxo de prazos', async () => {
    setClockForTests(NOON, { frozen: true });

    const result = await runDeadlineReminders();

    expect(result.zones).toEqual(ALL_ZONES);
    expect(repo.candidates.mock.calls[0]![1].now).toEqual(NOON);
  });
});
