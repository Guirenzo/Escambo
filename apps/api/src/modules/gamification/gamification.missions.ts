import type { BrazilTimezone, Mission, MissionAction, MissionType } from '@escambo/types';
import { clock } from '../../utils/clock';
import {
  addDaysToDay,
  dayIn,
  endOfDayIn,
  localInstant,
  localParts,
  timezoneOf,
} from '../../utils/timezone';
import { notificationsService } from '../notifications/notifications.service';
import {
  missionsRepository,
  type MissionCatalogRow,
  type MissionWindow,
} from './gamification.missions.repository';

/**
 * Missões com prazo (RF-066, RN-054). Decisão do fuso: a "meia-noite" e o "domingo às 23:59" da
 * RN-054 são os do fuso da conta (users.timezone, Brasília para quem não escolheu), como a sequência
 * de dias e os avisos (ADR 46): a missão é da pessoa, e uma diária que virasse às 21h de Manaus ou
 * à 1h de Noronha teria um "hoje" que não é o dela. A semana vai de segunda 00:00 a domingo
 * 23:59:59. Quem troca de fuso no meio do período passa a contar no fuso novo: a chave do período
 * é a do dia (ou da segunda-feira) no fuso de agora, e a janela das contagens também.
 *
 * Expiração sem job: o período vigente é a chave da linha (user_missions.period_key); virou o dia ou
 * a semana, a chave nova começa do zero e a antiga não é mais lida (o progresso incompleto se perde).
 * O progresso é recontado na fonte dentro da janela do período a cada evento, então repetir o
 * evento não soma de novo; a conclusão trava a linha e credita o XP uma vez só.
 */

export const MISSION_ACTIONS = [
  'complete_contracts',
  'fast_response_hours',
  'daily_login',
  'complete_barter',
] as const satisfies readonly MissionAction[];
const MISSION_TYPES = ['daily', 'weekly', 'achievement'] as const satisfies readonly MissionType[];

const isAction = (v: unknown): v is MissionAction =>
  typeof v === 'string' && (MISSION_ACTIONS as readonly string[]).includes(v);
const isType = (v: unknown): v is MissionType =>
  typeof v === 'string' && (MISSION_TYPES as readonly string[]).includes(v);
const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

/** O período vigente de uma missão: a chave da linha, o começo e o fim (23:59:59, inclusive). */
export interface MissionPeriod {
  key: string;
  start: Date | null;
  expiresAt: Date | null;
}

/** 00:00:00 do dia "AAAA-MM-DD" no fuso, como instante. */
function startOfDayIn(zone: BrazilTimezone, day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return localInstant(zone, y!, m!, d!, 0, 0, 0);
}

/**
 * O período de `type` que contém `now`, no fuso da conta (RN-054): o dia (expira 23:59:59 dele), a
 * semana de segunda a domingo (expira domingo 23:59:59) ou, na conquista, um período só, sem prazo.
 */
export function missionPeriod(type: MissionType, zone: BrazilTimezone, now: Date): MissionPeriod {
  if (type === 'achievement') return { key: 'sempre', start: null, expiresAt: null };
  const today = dayIn(zone, now);
  if (type === 'daily') {
    return {
      key: `d:${today}`,
      start: startOfDayIn(zone, today),
      expiresAt: endOfDayIn(zone, today),
    };
  }
  // weekday: 0 = domingo … 6 = sábado; a semana começa na segunda.
  const monday = addDaysToDay(today, -((localParts(zone, now).weekday + 6) % 7));
  return {
    key: `w:${monday}`,
    start: startOfDayIn(zone, monday),
    expiresAt: endOfDayIn(zone, addDaysToDay(monday, 6)),
  };
}

/** A janela das contagens do período: do começo até o segundo seguinte ao 23:59:59 (exclusivo). */
export const windowOf = (p: MissionPeriod): MissionWindow => ({
  start: p.start,
  end: p.expiresAt ? new Date(p.expiresAt.getTime() + 1000) : null,
});

/** Missão do catálogo já interpretada. */
export interface CatalogMission {
  id: number;
  title: string;
  description: string | null;
  type: MissionType;
  action: MissionAction;
  xpReward: number;
  target: number;
  /** Só na `fast_response_hours`: o limite de horas da resposta. */
  hours: number | null;
}

/**
 * Lê o critério do seed (`{"action": ..., "count": n}`). Missão com ação desconhecida ou critério
 * quebrado fica fora (não daria para cumprir). Na `fast_response_hours` o count é o limite em
 * horas (o texto do seed é "Responda propostas em menos de 2 horas") e a meta é uma resposta no
 * período; na `daily_login` a presença conta uma vez por período, então a meta é 1. Nas outras, o
 * count é a meta.
 */
export function parseMission(row: MissionCatalogRow): CatalogMission | null {
  let criteria: unknown = row.criteria;
  if (typeof criteria === 'string') {
    try {
      criteria = JSON.parse(criteria);
    } catch {
      return null;
    }
  }
  if (!criteria || typeof criteria !== 'object' || !isType(row.type)) return null;
  const { action, count } = criteria as { action?: unknown; count?: unknown };
  if (!isAction(action) || !isPositiveInt(count)) return null;
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    type: row.type,
    action,
    xpReward: Number(row.xp_reward),
    target: action === 'fast_response_hours' || action === 'daily_login' ? 1 : count,
    hours: action === 'fast_response_hours' ? count : null,
  };
}

/** Quanto a pessoa já fez no período, contado na fonte (a presença é o próprio acesso). */
function valueOf(
  m: CatalogMission,
  userId: number,
  window: MissionWindow,
  presence: boolean,
): Promise<number> {
  switch (m.action) {
    case 'daily_login':
      return Promise.resolve(presence ? 1 : 0);
    case 'complete_contracts':
      return missionsRepository.countCompletedContracts(userId, window);
    case 'fast_response_hours':
      return missionsRepository.countFastResponses(userId, window, m.hours!);
    case 'complete_barter':
      return missionsRepository.countCompletedBarters(userId, window);
  }
}

export interface EvaluateOptions {
  /** Só as missões destas ações (o evento que chegou); sem isto, todas as do catálogo. */
  actions?: readonly MissionAction[];
  /** O pedido é um acesso da pessoa: conta a `daily_login` do período. */
  presence?: boolean;
}

/**
 * Atualiza as missões da pessoa no período vigente e devolve como ficaram. Para cada missão ainda
 * não cumprida, reconta a fonte na janela, grava o progresso se subiu e, na meta, conclui com o XP
 * do catálogo e um aviso. Quem não pode cumprir missões (sem perfil de freelancer, suspenso,
 * banido ou excluído) recebe a lista vazia e nada é gravado.
 */
async function evaluate(userId: number, opts: EvaluateOptions = {}): Promise<Mission[]> {
  const account = await missionsRepository.findAccount(userId);
  if (!account) return [];
  const zone = timezoneOf(account.timezone);
  const now = clock.now();
  const catalog = (await missionsRepository.listActive())
    .map(parseMission)
    .filter((m): m is CatalogMission => m !== null)
    .filter((m) => !opts.actions || opts.actions.includes(m.action));
  if (catalog.length === 0) return [];

  const periods = new Map(catalog.map((m) => [m.id, missionPeriod(m.type, zone, now)]));
  const keys = [...new Set([...periods.values()].map((p) => p.key))];
  const stored = new Map(
    (await missionsRepository.listForPeriods(userId, keys))
      .filter((r) => periods.get(Number(r.mission_id))?.key === r.period_key)
      .map((r) => [Number(r.mission_id), r]),
  );

  const out: Mission[] = [];
  for (const m of catalog) {
    const period = periods.get(m.id)!;
    const row = stored.get(m.id);
    let progress = Math.min(m.target, Number(row?.progress ?? 0));
    let completedAt: Date | null = row && Number(row.is_completed) === 1 ? row.completed_at : null;
    if (!row || Number(row.is_completed) !== 1) {
      const value = Math.min(
        m.target,
        await valueOf(m, userId, windowOf(period), opts.presence === true),
      );
      if (value > progress) {
        await missionsRepository.saveProgress({
          userId,
          missionId: m.id,
          periodKey: period.key,
          progress: value,
          expiresAt: period.expiresAt,
        });
        progress = value;
      }
      if (progress >= m.target) {
        const newly = await missionsRepository.complete({
          userId,
          missionId: m.id,
          periodKey: period.key,
          xp: m.xpReward,
          now,
        });
        // Concluída agora ou, em paralelo, por outra chamada: cumprida do mesmo jeito.
        completedAt = now;
        // A presença do dia se cumpre ao abrir o próprio cartão de missões: quem a cumpriu está
        // olhando para ela. Um aviso por dia só encheria o sino (o XP sai do mesmo jeito).
        if (newly && m.action !== 'daily_login') {
          void notificationsService.notify(userId, {
            type: 'mission_completed',
            title: `Missão cumprida: ${m.title}`,
            body: m.xpReward > 0 ? `Você ganhou ${m.xpReward} XP.` : null,
            data: { missionId: m.id },
          });
        }
      }
    }
    out.push({
      id: m.id,
      title: m.title,
      description: m.description,
      type: m.type,
      action: m.action,
      xpReward: m.xpReward,
      progress,
      target: m.target,
      completed: completedAt !== null,
      completedAt: completedAt ? new Date(completedAt).toISOString() : null,
      expiresAt: period.expiresAt ? period.expiresAt.toISOString() : null,
    });
  }
  return out;
}

export const missionsService = {
  evaluate,

  /**
   * As missões do período vigente para a tela (GET /api/gamification/missions). Abrir conta como o
   * acesso do dia (`daily_login`, "Acesse a plataforma hoje"): é o Início que carrega o cartão.
   */
  list(userId: number): Promise<Mission[]> {
    return evaluate(userId, { presence: true });
  },
};
