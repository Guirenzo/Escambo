import { describe, expect, it } from 'vitest';
import { rn029Eligible, zoneOf } from './deadline-sql';
import {
  BEFORE_KINDS,
  REMINDER_PAGE,
  REMINDERS,
  STALLED_KINDS,
  candidatesSql,
  claimSql,
  type ReminderKind,
} from './reminders-sql';

/** Espaços e quebras de linha reduzidos a um espaço, como o banco falso guarda as instruções. */
const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
/** Os parâmetros nomeados de uma instrução, sem repetição e em ordem alfabética. */
const placeholders = (sql: string): string[] => [...new Set(sql.match(/:[A-Za-z]+/g) ?? [])].sort();

const RUNNING = "c.status IN ('accepted', 'in_progress')";
const CLIENT_GATE = `${zoneOf('cu.timezone')} IN (:zones) AND cu.deleted_at IS NULL`;
const FREELANCER_GATE = `${zoneOf('fu.timezone')} IN (:zones) AND fu.deleted_at IS NULL`;
const MILESTONE_FROM = 'contracts c STRAIGHT_JOIN contract_milestones m ON m.contract_id = c.id';

const KINDS = Object.keys(REMINDERS) as ReminderKind[];
const MILESTONE_KINDS = KINDS.filter((k) => REMINDERS[k].row === 'milestone');
const CONTRACT_KINDS = KINDS.filter((k) => REMINDERS[k].row === 'contract');
const entityOf = (k: ReminderKind): string => (REMINDERS[k].row === 'milestone' ? 'm.id' : 'c.id');

/**
 * O mapa dos lembretes (ADR 58) só monta texto SQL: aqui se confere que a leitura das candidatas e
 * a trava saem do MESMO estado, vencimento e armação (a condição lida é a gravada), a janela de
 * cada tipo e o portão dos fusos. Se o SQL roda no MySQL é dos testes de integração.
 */
describe('mapa dos lembretes (ADR 58)', () => {
  it('cada tipo lembra a linha, o vencimento e a armação certos, a quem age, no estado em que o aviso é verdadeiro', () => {
    expect(REMINDERS).toEqual({
      proposal: {
        row: 'contract',
        recipient: 'freelancer',
        due: 'c.proposal_expires_at',
        seq: '0',
        start: 'c.created_at',
        state: "c.status = 'pending' AND c.barter_agreement_id IS NULL",
        timing: 'before',
      },
      delivery: {
        row: 'contract',
        recipient: 'freelancer',
        due: 'c.deadline_at',
        seq: '0',
        start:
          'CAST(GREATEST(c.accepted_at, COALESCE(c.deadline_extended_at, c.accepted_at), COALESCE(c.extension_resolved_at, c.accepted_at)) AS DATETIME)',
        state: `${rn029Eligible('c')} AND c.extension_status <> 'pending'`,
        timing: 'before',
      },
      approval: {
        row: 'contract',
        recipient: 'client',
        due: 'c.approval_due_at',
        seq: '0',
        start: '(SELECT MAX(d.created_at) FROM deliveries d WHERE d.contract_id = c.id)',
        state: "c.status = 'delivered'",
        timing: 'before',
      },
      milestone_approval: {
        row: 'milestone',
        recipient: 'client',
        due: 'm.approval_due_at',
        seq: '0',
        start: 'm.delivered_at',
        state: `m.status = 'delivered' AND ${RUNNING}`,
        timing: 'before',
      },
      extension: {
        row: 'contract',
        recipient: 'client',
        due: 'c.extension_respond_by',
        seq: 'c.extension_requests',
        start: 'c.extension_requested_at',
        state: `c.extension_status = 'pending' AND ${rn029Eligible('c')}`,
        timing: 'before',
      },
      revision: {
        row: 'contract',
        recipient: 'both',
        due: 'c.revision_requested_at',
        seq: '0',
        start: null,
        state: "c.status = 'revision_requested'",
        timing: 'stalled',
      },
      milestone_revision: {
        row: 'milestone',
        recipient: 'both',
        due: 'm.revision_requested_at',
        seq: '0',
        start: null,
        state: `m.status = 'funded' AND m.delivered_at IS NOT NULL AND ${RUNNING}`,
        timing: 'stalled',
      },
    });
  });

  it('o job percorre os lembretes antes do vencimento nesta ordem e depois as revisões paradas; nenhum tipo fica de fora', () => {
    expect(BEFORE_KINDS).toEqual([
      'proposal',
      'delivery',
      'approval',
      'milestone_approval',
      'extension',
    ]);
    expect(STALLED_KINDS).toEqual(['revision', 'milestone_revision']);
    expect([...BEFORE_KINDS, ...STALLED_KINDS].sort()).toEqual([...KINDS].sort());
    for (const k of BEFORE_KINDS) expect(REMINDERS[k].timing).toBe('before');
    for (const k of STALLED_KINDS) expect(REMINDERS[k].timing).toBe('stalled');
  });

  it('a página das candidatas tem 200 linhas', () => {
    expect(REMINDER_PAGE).toBe(200);
  });

  describe.each(KINDS)('%s', (kind) => {
    const s = REMINDERS[kind];
    const e = entityOf(kind);
    const candidates = flat(candidatesSql(kind));
    const claim = flat(claimSql(kind));

    it('a candidata e a trava repetem o MESMO estado, vencimento, armação e início', () => {
      const state = flat(s.state);
      expect(candidates).toContain(`WHERE ${state} AND `);
      expect(candidates).toContain(`${e} AS entity_id, ${s.due} AS due_at, ${s.seq} AS seq,`);
      expect(claim).toContain(`SELECT '${kind}', ${e}, ${s.due}, ${s.seq}, :now FROM `);
      expect(
        claim.endsWith(
          ` AND ${state} AND ${s.due} = :due AND ${s.seq} = :seq AND ${s.start ?? 'NULL'} <=> :start`,
        ),
      ).toBe(true);
      expect(candidates).toContain(`${s.start ?? 'NULL'} AS start_at,`);
    });

    it('a candidata traz o que o slot e o portão precisam, a partir da contratação', () => {
      expect(
        candidates.startsWith(
          `SELECT c.id AS contract_id, ${e} AS entity_id, ${s.due} AS due_at, ${s.seq} AS seq, ` +
            `${s.start ?? 'NULL'} AS start_at, c.client_id, c.freelancer_id, ` +
            'cu.timezone AS client_timezone, fu.timezone AS freelancer_timezone FROM ',
        ),
      ).toBe(true);
      expect(candidates).toContain(
        'JOIN users cu ON cu.id = c.client_id JOIN users fu ON fu.id = c.freelancer_id WHERE ',
      );
    });

    it('a candidata já lembrada (mesmo tipo, objeto, vencimento e armação) sai da fila', () => {
      expect(candidates).toContain(
        `AND NOT EXISTS (SELECT 1 FROM deadline_reminders r WHERE r.kind = '${kind}' ` +
          `AND r.entity_id = ${e} AND r.due_at = ${s.due} AND r.seq = ${s.seq})`,
      );
    });

    it('anda pela fila com o cursor (vencimento, id), na ordem do vencimento, uma página por vez', () => {
      expect(
        candidates.endsWith(
          `AND (${s.due} > :afterDue OR (${s.due} = :afterDue AND ${e} > :afterId)) ` +
            `ORDER BY ${s.due} ASC, ${e} ASC LIMIT ${REMINDER_PAGE}`,
        ),
      ).toBe(true);
    });

    it('a trava é um INSERT … SELECT sem IGNORE (outro erro não vira aviso) e nunca lê o fuso gravado do prazo', () => {
      expect(
        claim.startsWith(
          `INSERT INTO deadline_reminders (kind, entity_id, due_at, seq, sent_at) SELECT '${kind}', `,
        ),
      ).toBe(true);
      expect(claim).not.toContain('IGNORE');
      expect(candidates).not.toContain('deadline_zone');
      expect(claim).not.toContain('deadline_zone');
    });
  });

  describe.each(MILESTONE_KINDS)('tipo de marco %s', (kind) => {
    it('começa pela contratação e junta o marco (a ordem de trava do módulo)', () => {
      expect(flat(candidatesSql(kind))).toContain(`FROM ${MILESTONE_FROM} JOIN users cu `);
      expect(flat(claimSql(kind))).toContain(
        `FROM ${MILESTONE_FROM} WHERE c.id = :contractId AND m.id = :entityId AND `,
      );
    });

    it('a trava identifica o marco: pede a contratação e o marco', () => {
      expect(placeholders(claimSql(kind))).toEqual([
        ':contractId',
        ':due',
        ':entityId',
        ':now',
        ':seq',
        ':start',
      ]);
    });
  });

  describe.each(CONTRACT_KINDS)('tipo de contratação %s', (kind) => {
    it('lê só a contratação, sem juntar marco, e a trava não pede marco', () => {
      expect(flat(candidatesSql(kind))).toContain(
        'FROM contracts c JOIN users cu ON cu.id = c.client_id ',
      );
      expect(flat(claimSql(kind))).toContain('FROM contracts c WHERE c.id = :contractId AND ');
      expect(candidatesSql(kind)).not.toContain('STRAIGHT_JOIN');
      expect(claimSql(kind)).not.toContain('STRAIGHT_JOIN');
      expect(placeholders(claimSql(kind))).toEqual([
        ':contractId',
        ':due',
        ':now',
        ':seq',
        ':start',
      ]);
    });
  });

  describe.each(BEFORE_KINDS)('lembrete antes do vencimento %s', (kind) => {
    const s = REMINDERS[kind];
    const sql = flat(candidatesSql(kind));

    it('só entra o vencimento entre 2 h e 48 h dali, de quem soube dele há pelo menos 12 h', () => {
      expect(sql).toContain(
        `AND ${s.due} >= :minDue AND ${s.due} < :maxDue AND (${s.start} IS NULL OR ${s.start} <= :aged) AND `,
      );
      expect(placeholders(sql)).toEqual([
        ':afterDue',
        ':afterId',
        ':aged',
        ':maxDue',
        ':minDue',
        ':zones',
      ]);
    });

    it('a trava repete o início que a leitura viu, com a comparação que aceita NULL (<=>)', () => {
      const claim = flat(claimSql(kind));
      expect(s.start).not.toBeNull();
      expect(claim.endsWith(` AND ${s.start} <=> :start`)).toBe(true);
      expect(claim).not.toContain('NULL <=> :start');
    });

    it('o portão é o fuso de quem age e só ele: precisa ser dia para quem recebe o lembrete', () => {
      const own = s.recipient === 'client' ? CLIENT_GATE : FREELANCER_GATE;
      const other = s.recipient === 'client' ? FREELANCER_GATE : CLIENT_GATE;
      expect(sql).toContain(`AND ${own} AND NOT EXISTS`);
      expect(sql).not.toContain(other);
    });
  });

  describe.each(STALLED_KINDS)('revisão parada %s', (kind) => {
    const s = REMINDERS[kind];
    const sql = flat(candidatesSql(kind));

    it('só entra o pedido de revisão de 7 dias ou mais, sem janela de vencimento nem idade', () => {
      expect(sql).toContain(`AND ${s.due} IS NOT NULL AND ${s.due} <= :staleBefore AND `);
      expect(placeholders(sql)).toEqual([':afterDue', ':afterId', ':staleBefore', ':zones']);
      expect(sql).toContain('NULL AS start_at');
    });

    it('a trava repete o início também aqui: sem início, NULL <=> :start (o job passa start null)', () => {
      const claim = flat(claimSql(kind));
      expect(s.start).toBeNull();
      expect(claim.endsWith(' AND NULL <=> :start')).toBe(true);
    });

    it('o portão exige as DUAS partes num fuso em que é dia, as duas com a conta ativa', () => {
      expect(sql).toContain(`AND ${CLIENT_GATE} AND ${FREELANCER_GATE} AND NOT EXISTS`);
    });
  });

  it('lembrete antes do vencimento sem início (start null) não filtra pela idade', () => {
    const original = REMINDERS.approval.start;
    REMINDERS.approval.start = null;
    try {
      const sql = flat(candidatesSql('approval'));
      expect(sql).toContain(
        'AND c.approval_due_at >= :minDue AND c.approval_due_at < :maxDue AND (NULL IS NULL OR NULL <= :aged) AND ',
      );
      expect(sql).toContain('NULL AS start_at');
    } finally {
      REMINDERS.approval.start = original;
    }
  });

  it('a trava da entrega repete o início com a resolução do pedido de extensão: a recusa entre a leitura e a trava muda o início e a trava não grava', () => {
    expect(flat(claimSql('delivery'))).toContain(
      'AND c.deadline_at = :due AND 0 = :seq AND CAST(GREATEST(c.accepted_at, COALESCE(c.deadline_extended_at, c.accepted_at), COALESCE(c.extension_resolved_at, c.accepted_at)) AS DATETIME) <=> :start',
    );
  });

  it('a entrega lembrada é a que ainda cobra (RN-029) e sem pedido de extensão esperando o cliente', () => {
    const sql = flat(candidatesSql('delivery'));
    expect(sql).toContain(
      `WHERE ${flat(rn029Eligible('c'))} AND c.extension_status <> 'pending' AND `,
    );
  });

  it('a extensão separa dois pedidos com a mesma hora de resposta pelo número do pedido', () => {
    expect(flat(claimSql('extension'))).toContain(
      "SELECT 'extension', c.id, c.extension_respond_by, c.extension_requests, :now FROM contracts c",
    );
    expect(flat(candidatesSql('extension'))).toContain(
      'r.due_at = c.extension_respond_by AND r.seq = c.extension_requests)',
    );
  });
});
