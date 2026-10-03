import { logger } from '../config/logger';
import { DEFAULT_DEADLINE_GRACE_HOURS } from '../modules/contracts/deadline-grace';
import { deadlineRemindersService } from '../modules/contracts/deadline-reminders.service';
import {
  remindersRepository,
  type ReminderCandidate,
} from '../modules/contracts/reminders.repository';
import {
  BEFORE_KINDS,
  REMINDERS,
  REMINDER_PAGE,
  STALLED_KINDS,
  type ReminderKind,
} from '../modules/contracts/reminders-sql';
import { settingsRepository } from '../modules/settings/settings.repository';
import { clock } from '../utils/clock';
import { dayZones, reminderDue, reminderSlot } from '../utils/human-hours';
import { timezoneOf } from '../utils/timezone';

/**
 * Lembretes antes de cada vencimento e aviso de revisão parada (ADR 58, RN-079 e RN-081). Roda
 * depois das sanções de prazo (não lembra o que acabou de acontecer) e antes do resumo diário (o
 * lembrete das 9h entra no resumo de quem escolheu 9h). Só age com quem recebe num fuso em que é
 * dia; o slot de cada lembrete é recalculado a cada rodada, no fuso atual de quem recebe, e nunca
 * gravado: quem muda de fuso é lembrado no fuso novo, e no máximo uma vez.
 */

/** Teto de páginas por tipo e rodada: o resto fica para a próxima (com aviso no log). */
const MAX_PAGES = 25;

export interface DeadlineRemindersResult {
  zones: string[];
  /** Objetos lembrados por tipo (contratação; marco nos tipos de marco). */
  sent: Record<ReminderKind, number[]>;
  /** Na janela, mas o slot ainda não chegou. */
  waiting: number;
  /** Trava perdida: o estado mudou, outra instância ganhou ou a trava estava ocupada. */
  lost: number;
  /** Contratações em que o envio falhou com erro. */
  failed: number[];
}

/** Todas as candidatas de um tipo, página a página pelo cursor (vencimento, id). */
async function* pages(
  kind: ReminderKind,
  now: Date,
  zones: ReturnType<typeof dayZones>,
): AsyncGenerator<ReminderCandidate[]> {
  let after = { due: new Date(0), id: 0 };
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await remindersRepository.candidates(kind, { now, zones, after });
    if (rows.length > 0) yield rows;
    if (rows.length < REMINDER_PAGE) return;
    const last = rows[rows.length - 1]!;
    after = { due: new Date(last.due_at), id: last.entity_id };
  }
  logger.warn({ kind }, 'lembretes: teto de páginas na rodada; o resto fica para a próxima');
}

export async function runDeadlineReminders(
  now: Date = clock.now(),
): Promise<DeadlineRemindersResult> {
  const zones = dayZones(now);
  const result: DeadlineRemindersResult = {
    zones,
    sent: {
      proposal: [],
      delivery: [],
      approval: [],
      milestone_approval: [],
      extension: [],
      revision: [],
      milestone_revision: [],
    },
    waiting: 0,
    lost: 0,
    failed: [],
  };
  if (zones.length === 0) return result;

  let graceHours: number | null = null;
  const attempt = async (contractId: number, kind: ReminderKind, run: () => Promise<number[]>) => {
    try {
      const ids = await run();
      if (ids.length > 0) result.sent[kind].push(...ids);
      else result.lost++;
    } catch (err) {
      result.failed.push(contractId);
      logger.warn({ err, contractId, kind }, 'lembrete falhou');
    }
  };

  for (const kind of BEFORE_KINDS) {
    const recipient = REMINDERS[kind].recipient;
    // Os marcos da mesma contratação que vencem na rodada viram um aviso só.
    const milestoneGroups = new Map<number, ReminderCandidate[]>();
    for await (const rows of pages(kind, now, zones)) {
      for (const c of rows) {
        const zone = timezoneOf(recipient === 'client' ? c.client_timezone : c.freelancer_timezone);
        const due = new Date(c.due_at);
        const slot = reminderSlot({ start: c.start_at ? new Date(c.start_at) : null, due, zone });
        if (!reminderDue({ now, slot, due, zone })) {
          result.waiting++;
          continue;
        }
        if (kind === 'milestone_approval') {
          const list = milestoneGroups.get(c.contract_id) ?? [];
          list.push(c);
          milestoneGroups.set(c.contract_id, list);
          continue;
        }
        if (kind === 'delivery' && graceHours === null) {
          graceHours = await settingsRepository.getNumber(
            'deadline_grace_hours',
            DEFAULT_DEADLINE_GRACE_HOURS,
          );
        }
        const one = async (ok: Promise<boolean>): Promise<number[]> =>
          (await ok) ? [c.entity_id] : [];
        await attempt(c.contract_id, kind, () =>
          one(
            kind === 'proposal'
              ? deadlineRemindersService.proposal(c, now)
              : kind === 'delivery'
                ? deadlineRemindersService.delivery(c, graceHours!, now)
                : kind === 'approval'
                  ? deadlineRemindersService.approval(c, now)
                  : deadlineRemindersService.extension(c, now),
          ),
        );
      }
    }
    for (const [contractId, rows] of milestoneGroups) {
      await attempt(contractId, kind, () =>
        deadlineRemindersService.milestoneApprovals(contractId, rows, now),
      );
    }
  }

  // Revisão parada: o portão das duas partes de dia já está no SQL; toda candidata sai.
  for (const kind of STALLED_KINDS) {
    for await (const rows of pages(kind, now, zones)) {
      for (const c of rows) {
        await attempt(c.contract_id, kind, async () =>
          (await (kind === 'revision'
            ? deadlineRemindersService.revisionStalled(c, now)
            : deadlineRemindersService.milestoneRevisionStalled(c, now)))
            ? [c.entity_id]
            : [],
        );
      }
    }
  }
  return result;
}
