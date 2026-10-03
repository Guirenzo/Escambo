import { rn029Eligible, zoneOf } from './deadline-sql';

/**
 * O mapa dos lembretes (ADR 58), num lugar só: a consulta das candidatas e a trava são montadas do
 * MESMO estado, vencimento e armação, para a condição lida ser a condição gravada (como os
 * predicados do ADR 57). Só monta texto SQL: puro, com teste de unidade.
 */

export type ReminderKind =
  | 'proposal'
  | 'delivery'
  | 'approval'
  | 'milestone_approval'
  | 'extension'
  | 'revision'
  | 'milestone_revision';

export interface ReminderSpec {
  /** A linha lembrada: a contratação, ou o marco (com a contratação junto). */
  row: 'contract' | 'milestone';
  /** Quem age: e é no fuso dessa pessoa que o lembrete espera o dia. */
  recipient: 'client' | 'freelancer' | 'both';
  /** O vencimento lembrado; na revisão parada, a hora do pedido. */
  due: string;
  /** Número da armação quando o vencimento sozinho não a identifica; senão '0'. */
  seq: string;
  /** Quando a pessoa soube do vencimento; null = sem restrição de idade. */
  start: string | null;
  /** Estado em que o aviso é verdadeiro. */
  state: string;
  /** 'before': lembrete antes de vencer; 'stalled': aviso depois de 7 dias parado. */
  timing: 'before' | 'stalled';
}

const RUNNING = "c.status IN ('accepted', 'in_progress')";

export const REMINDERS: Record<ReminderKind, ReminderSpec> = {
  // Troca não expira (RN-021): sem lembrete.
  proposal: {
    row: 'contract',
    recipient: 'freelancer',
    due: 'c.proposal_expires_at',
    seq: '0',
    start: 'c.created_at',
    state: "c.status = 'pending' AND c.barter_agreement_id IS NULL",
    timing: 'before',
  },
  // A recusa ou a expiração de um pedido entra no início: o aviso dela já disse "vale o prazo
  // atual", e o lembrete não sai nas 12 h seguintes. O pedido pendente segura o lembrete.
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
  // Dois pedidos para a mesma data têm a mesma hora de resposta: o número do pedido os separa.
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
};

/** Os tipos de lembrete antes do vencimento, na ordem em que o job os percorre. */
export const BEFORE_KINDS: ReminderKind[] = [
  'proposal',
  'delivery',
  'approval',
  'milestone_approval',
  'extension',
];
export const STALLED_KINDS: ReminderKind[] = ['revision', 'milestone_revision'];

/** Uma página das candidatas. */
export const REMINDER_PAGE = 200;

const entityOf = (s: ReminderSpec): string => (s.row === 'milestone' ? 'm.id' : 'c.id');
// A contratação vem sempre primeiro: é a ordem de trava de todo o módulo.
const fromOf = (s: ReminderSpec): string =>
  s.row === 'milestone'
    ? 'contracts c STRAIGHT_JOIN contract_milestones m ON m.contract_id = c.id'
    : 'contracts c';

function gateOf(s: ReminderSpec): string {
  const client = `${zoneOf('cu.timezone')} IN (:zones) AND cu.deleted_at IS NULL`;
  const freelancer = `${zoneOf('fu.timezone')} IN (:zones) AND fu.deleted_at IS NULL`;
  if (s.recipient === 'client') return client;
  if (s.recipient === 'freelancer') return freelancer;
  // A revisão parada só sai com as DUAS partes de dia.
  return `${client} AND ${freelancer}`;
}

function windowOf(s: ReminderSpec): string {
  if (s.timing === 'stalled') return `${s.due} IS NOT NULL AND ${s.due} <= :staleBefore`;
  // Condição necessária do slot: tira da fila o que ainda não pode sair (nem pela idade).
  const start = s.start ?? 'NULL';
  return `${s.due} >= :minDue AND ${s.due} < :maxDue AND (${start} IS NULL OR ${start} <= :aged)`;
}

/** Candidatas de um tipo: uma página a partir do cursor (vencimento, id), na ordem do vencimento. */
export function candidatesSql(kind: ReminderKind): string {
  const s = REMINDERS[kind];
  const e = entityOf(s);
  return `SELECT c.id AS contract_id, ${e} AS entity_id, ${s.due} AS due_at, ${s.seq} AS seq,
       ${s.start ?? 'NULL'} AS start_at, c.client_id, c.freelancer_id,
       cu.timezone AS client_timezone, fu.timezone AS freelancer_timezone
  FROM ${fromOf(s)}
  JOIN users cu ON cu.id = c.client_id
  JOIN users fu ON fu.id = c.freelancer_id
 WHERE ${s.state}
   AND ${windowOf(s)}
   AND ${gateOf(s)}
   AND NOT EXISTS (SELECT 1 FROM deadline_reminders r
                    WHERE r.kind = '${kind}' AND r.entity_id = ${e} AND r.due_at = ${s.due}
                      AND r.seq = ${s.seq})
   AND (${s.due} > :afterDue OR (${s.due} = :afterDue AND ${e} > :afterId))
 ORDER BY ${s.due} ASC, ${e} ASC
 LIMIT ${REMINDER_PAGE}`;
}

/**
 * A trava: um INSERT … SELECT que repete o estado, o vencimento, a armação e o início que a leitura
 * viu (o slot foi calculado com ele: uma recusa do pedido de extensão muda o início da entrega sem
 * mudar a chave), na transação que trava a contratação e grava o aviso. 0 linhas = o estado mudou; ER_DUP_ENTRY = outra
 * instância ganhou. Sem INSERT IGNORE (rebaixaria outros erros a aviso).
 */
export function claimSql(kind: ReminderKind): string {
  const s = REMINDERS[kind];
  const e = entityOf(s);
  return `INSERT INTO deadline_reminders (kind, entity_id, due_at, seq, sent_at)
SELECT '${kind}', ${e}, ${s.due}, ${s.seq}, :now
  FROM ${fromOf(s)}
 WHERE c.id = :contractId${s.row === 'milestone' ? ' AND m.id = :entityId' : ''}
   AND ${s.state} AND ${s.due} = :due AND ${s.seq} = :seq AND ${s.start ?? 'NULL'} <=> :start`;
}
