import type { ModerationHealthDay } from '@escambo/types';
import { env } from '../../config/env';
import { ptDecimal } from '../../utils/csv';
import { clockBrt, dayMonth } from './moderation.day';
import type { QueueSnapshot } from './moderation.health';

/**
 * Relatório diário da meta da moderação (ADR 55): as contas e o texto, puros. O job decide
 * quando rodar e quem recebe; aqui fica o que é "meta estourada" e o que o e-mail diz.
 */

export interface Breach {
  /** A mediana de ontem passou da meta. */
  slow: boolean;
  /** Alguma denúncia de conteúdo espera agora há mais que a meta. */
  waiting: boolean;
  breached: boolean;
}

/**
 * Os dois critérios, porque cada um cega para um caso: a mediana é sobre decididas e fica nula
 * numa fila abandonada; a fila sozinha não vê o dia lento que terminou. Sem piso de decisões:
 * no volume do Escambo, um dia com uma decisão só é o dia comum, e uma decisão de 30 h é a meta
 * perdida (o e-mail diz quantas houve para o admin pesar).
 */
export function isBreached(
  yesterday: ModerationHealthDay | undefined,
  queue: QueueSnapshot,
  slaHours: number,
): Breach {
  const slow =
    yesterday !== undefined && yesterday.medianHours !== null && yesterday.medianHours > slaHours;
  const waiting = queue.overSla > 0;
  return { slow, waiting, breached: slow || waiting };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const hours = (v: number): string => `${ptDecimal(v, 1)} h`;

export interface ReportMailInput {
  yesterday: ModerationHealthDay | undefined;
  yesterdayDay: string;
  queue: QueueSnapshot;
  now: Date;
  slaHours: number;
  digestHour: number;
  /** Quando a meta foi alterada hoje (ou null): o texto diz que a régua é a de hoje. */
  slaChangedAt: Date | null;
}

export interface ReportMailVars {
  title: string;
  paragraphs: string[];
  link: string;
}

/**
 * O e-mail, palavra por palavra. Só agregados: nunca id, nome, trecho ou e-mail de ninguém —
 * o destinatário pode ser um admin que ainda não confirmou o e-mail.
 */
export function reportMail(input: ReportMailInput): ReportMailVars {
  const { yesterday, queue, now, slaHours } = input;
  const breach = isBreached(yesterday, queue, slaHours);
  const dm = dayMonth(input.yesterdayDay);
  const meta = `${slaHours} h`;

  const title =
    breach.slow && breach.waiting
      ? `Moderação: meta de ${meta} estourada ontem e agora`
      : breach.slow
        ? `Moderação: ontem (${dm}) a fila passou da meta de ${meta}`
        : `Moderação: ${plural(queue.overSla, 'denúncia espera', 'denúncias esperam')} há mais que a meta de ${meta}`;

  const paragraphs: string[] = [];

  // Ontem.
  const received = yesterday?.received ?? 0;
  const decided = (yesterday?.actioned ?? 0) + (yesterday?.dismissed ?? 0);
  let p1: string;
  if (decided === 0) {
    p1 = `Ontem (${dm}) ${received === 1 ? 'entrou 1 denúncia' : `entraram ${received} denúncias`} e a fila não decidiu nenhuma.`;
  } else {
    const median =
      yesterday?.medianHours != null
        ? `, levando ${hours(yesterday.medianHours)} na mediana para decidir, ${yesterday.medianHours > slaHours ? 'acima' : 'dentro'} da meta de ${meta}`
        : '';
    p1 = `Ontem (${dm}) ${received === 1 ? 'entrou 1 denúncia' : `entraram ${received} denúncias`} e a fila decidiu ${decided} (${yesterday?.actioned ?? 0} com ação, ${plural(yesterday?.dismissed ?? 0, 'dispensada', 'dispensadas')})${median}.`;
  }
  if ((yesterday?.flagged ?? 0) > 0) {
    p1 += ` O detector sinalizou ${plural(yesterday!.flagged, 'mensagem', 'mensagens')}.`;
  }
  paragraphs.push(p1);

  // Agora.
  const content = queue.pending - queue.reviews;
  const reviews = queue.reviews;
  const reviewsNote =
    reviews > 0
      ? ` Fora isso, ${plural(reviews, 'conta', 'contas')} em revisão por reincidência, sem meta.`
      : '';
  if (content === 0 && reviews === 0) {
    paragraphs.push('Agora a fila está vazia.');
  } else if (content === 0) {
    paragraphs.push(
      `Agora a fila só tem ${plural(reviews, 'conta', 'contas')} em revisão por reincidência, que não entram na meta.`,
    );
  } else {
    const oldestH =
      queue.oldestContent != null
        ? hours((now.getTime() - new Date(queue.oldestContent).getTime()) / 3_600_000)
        : '0,0 h';
    if (queue.overSla === 0) {
      paragraphs.push(
        `Agora ${plural(content, 'denúncia espera', 'denúncias esperam')} decisão; a mais antiga há ${oldestH}, nenhuma passou da meta.${reviewsNote}`,
      );
    } else {
      const items =
        queue.overSlaItems !== queue.overSla
          ? `, em ${plural(queue.overSlaItems, 'item', 'itens')} da fila`
          : '';
      paragraphs.push(
        `Agora ${plural(content, 'denúncia espera', 'denúncias esperam')} decisão; a mais antiga há ${oldestH} e ${queue.overSla} ${queue.overSla === 1 ? 'passou' : 'passaram'} da meta${items}.${reviewsNote}`,
      );
    }
  }

  if (input.slaChangedAt) {
    paragraphs.push(`A meta de ${meta} foi alterada hoje às ${clockBrt(input.slaChangedAt)}.`);
  }

  paragraphs.push(
    `Este e-mail sai no máximo uma vez por dia, a partir das ${input.digestHour}h de Brasília, e só quando a meta estoura. Para desligar: painel admin › Parâmetros da plataforma › Relatório da meta da moderação.`,
  );

  return {
    title,
    paragraphs,
    link: `${env.APP_URL.replace(/\/$/, '')}/admin#health-title`,
  };
}
