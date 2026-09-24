import { env } from '../config/env';
import { logger } from '../config/logger';
import { authRepository } from '../modules/auth/auth.repository';
import { mailService } from '../modules/mail/mail.service';
import { DAY_MS, dayKey, startOfTodayBrt } from '../modules/reports/moderation.day';
import { moderationHealthService, openQueue } from '../modules/reports/moderation.health';
import { isBreached, reportMail } from '../modules/reports/moderation.sla-report';
import {
  isDue,
  nextState,
  parseState,
  REPORT_STATE_KEY,
} from '../modules/reports/moderation.sla-state';
import { settingsRepository } from '../modules/settings/settings.repository';
import { settingsService } from '../modules/settings/settings.service';
import { hourIn, DEFAULT_TIMEZONE } from '../utils/timezone';

/**
 * Relatório diário da meta da moderação (ADR 55). Uma vez por dia de Brasília, a partir de
 * DIGEST_HOUR (a hora em que a plataforma manda coisas diárias), confere ontem e a fila; se a
 * meta estourou, cada admin recebe um e-mail com os números e o link do painel. A marca do dia
 * é gravada ANTES do envio, por compare-and-set: duas instâncias mandam um só; cada entrega aceita
 * atualiza a marca na hora, então um reinício no meio não repete o e-mail. Com estouro e
 * nenhuma entrega aceita, tenta de novo de hora em hora, até três vezes; sem admin no banco,
 * tenta de novo de hora em hora até aparecer um. Só e-mail, direto, furando a frequência de
 * e-mail da conta de propósito: é aviso ao papel de admin, e a chave do painel desliga.
 */

export interface ModerationSlaReportResult {
  skipped: 'mail_off' | 'disabled' | 'before_hour' | 'already_today' | 'claimed_elsewhere' | null;
  breached: boolean;
  slow: boolean;
  waiting: boolean;
  recipients: number;
  delivered: number;
  attempts: number;
  provider: string | null;
}

const nothing = (skipped: ModerationSlaReportResult['skipped']): ModerationSlaReportResult => ({
  skipped,
  breached: false,
  slow: false,
  waiting: false,
  recipients: 0,
  delivered: 0,
  attempts: 0,
  provider: null,
});

export async function runModerationSlaReport(
  now: Date = new Date(),
): Promise<ModerationSlaReportResult> {
  // Do mais barato ao mais caro: o provedor é puro; a chave tem cache; a hora não custa nada.
  if (!mailService.enabled()) return nothing('mail_off');
  if (!(await settingsService.flag('moderation_sla_report_enabled'))) return nothing('disabled');
  if (hourIn(DEFAULT_TIMEZONE, now) < env.DIGEST_HOUR) return nothing('before_hour');
  const raw = await settingsRepository.get(REPORT_STATE_KEY);
  const state = parseState(raw);
  if (!isDue(state, now)) return nothing('already_today');

  const slaHours = await settingsService.number('moderation_sla_hours');
  const [series, queue, slaRow, admins] = await Promise.all([
    moderationHealthService.history(1, now),
    openQueue(now, slaHours),
    settingsRepository.list(['moderation_sla_hours']).then((rows) => rows[0]),
    authRepository.listAdmins(),
  ]);
  const yesterdayDay = dayKey(new Date(now.getTime() - DAY_MS));
  const yesterday = series.history.find((d) => d.day === yesterdayDay);
  const breach = isBreached(yesterday, queue, slaHours);

  // A trava do dia, antes de qualquer envio: quem não conseguir gravar deixa para a outra instância.
  const next = nextState(state, now, breach.breached, slaHours, admins.length);
  if (!(await settingsRepository.setIf(REPORT_STATE_KEY, JSON.stringify(next), raw))) {
    return nothing('claimed_elsewhere');
  }
  const base: ModerationSlaReportResult = {
    skipped: null,
    breached: breach.breached,
    slow: breach.slow,
    waiting: breach.waiting,
    recipients: admins.length,
    delivered: 0,
    attempts: next.attempts,
    provider: env.MAIL_PROVIDER,
  };
  if (!breach.breached) return base;
  if (admins.length === 0) {
    logger.warn('relatório da moderação: meta estourada e nenhum admin no banco');
    return base;
  }

  const slaChangedAt =
    slaRow?.updated_at && new Date(slaRow.updated_at) >= startOfTodayBrt(now)
      ? new Date(slaRow.updated_at)
      : null;
  const vars = reportMail({
    yesterday,
    yesterdayDay,
    queue,
    now,
    slaHours,
    digestHour: env.DIGEST_HOUR,
    slaChangedAt,
  });
  // Cada entrega aceita vai para a marca na hora, pelo mesmo compare-and-set: um reinício no meio
  // do laço não faz a próxima tentativa repetir o e-mail (com uma entrega gravada o dia fecha). Se a
  // marca mudou por fora, outra execução assumiu: para de enviar.
  let delivered = 0;
  let mark = JSON.stringify(next);
  for (const admin of admins) {
    const r = await mailService.deliver({
      userId: admin.id,
      to: admin.email,
      template: 'moderation_report',
      vars,
    });
    if (!r.delivered) continue;
    delivered += 1;
    const updated = JSON.stringify({ ...next, delivered });
    if (!(await settingsRepository.setIf(REPORT_STATE_KEY, updated, mark))) {
      logger.warn('relatório da moderação: a marca do dia mudou durante o envio; parando');
      break;
    }
    mark = updated;
  }
  if (delivered === 0)
    logger.warn(
      { recipients: admins.length },
      'relatório da moderação: nenhum e-mail aceito pelo provedor',
    );
  if (env.MAIL_PROVIDER === 'simulated') {
    logger.warn('relatório da moderação: provedor simulado, o e-mail fica só na caixa de saída');
  }
  return { ...base, delivered };
}
