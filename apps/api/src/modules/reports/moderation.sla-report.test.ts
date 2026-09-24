import { describe, expect, it } from 'vitest';
import type { ModerationHealthDay } from '@escambo/types';
import { env } from '../../config/env';
import type { QueueSnapshot } from './moderation.health';
import { isBreached, reportMail } from './moderation.sla-report';

// 09:00 em Brasília.
const AGORA = new Date('2026-09-24T12:00:00Z');

const ontem = (over: Partial<ModerationHealthDay> = {}): ModerationHealthDay => ({
  day: '2026-09-23',
  received: 4,
  flagged: 0,
  actioned: 2,
  dismissed: 1,
  medianHours: 6,
  ...over,
});
const fila = (over: Partial<QueueSnapshot> = {}): QueueSnapshot => ({
  pending: 0,
  oldest: null,
  automatic: 0,
  reviews: 0,
  oldestContent: null,
  overSla: 0,
  overSlaItems: 0,
  ...over,
});
const mail = (
  y: ModerationHealthDay | undefined,
  q: QueueSnapshot,
  over: Partial<Parameters<typeof reportMail>[0]> = {},
) =>
  reportMail({
    yesterday: y,
    yesterdayDay: '2026-09-23',
    queue: q,
    now: AGORA,
    slaHours: 24,
    digestHour: 8,
    slaChangedAt: null,
    ...over,
  });

/** Relatório diário da meta (ADR 55): o que é "estourou" e o que o e-mail diz, só em agregados. */
describe('isBreached', () => {
  it('a mediana de ontem acima da meta ou uma denúncia esperando há mais que a meta', () => {
    expect(isBreached(ontem({ medianHours: 30 }), fila(), 24)).toEqual({
      slow: true,
      waiting: false,
      breached: true,
    });
    expect(isBreached(ontem(), fila({ pending: 1, overSla: 1 }), 24)).toEqual({
      slow: false,
      waiting: true,
      breached: true,
    });
    expect(isBreached(ontem({ medianHours: 30 }), fila({ overSla: 2 }), 24).breached).toBe(true);
  });

  it('dentro da meta, exatamente na meta, sem decisão ontem ou sem ontem: não estourou', () => {
    expect(isBreached(ontem(), fila(), 24).breached).toBe(false);
    expect(isBreached(ontem({ medianHours: 24 }), fila(), 24).breached).toBe(false);
    expect(isBreached(ontem({ medianHours: null }), fila(), 24).breached).toBe(false);
    expect(isBreached(undefined, fila(), 24).breached).toBe(false);
    // Fila cheia mas nova, ou só com revisões de conta: não é estouro.
    expect(isBreached(ontem(), fila({ pending: 5, overSla: 0 }), 24).breached).toBe(false);
    expect(isBreached(ontem(), fila({ pending: 2, reviews: 2, overSla: 0 }), 24).breached).toBe(
      false,
    );
  });
});

describe('reportMail', () => {
  it('assunto por caso: ontem, agora, ou os dois', () => {
    expect(mail(ontem({ medianHours: 30 }), fila()).title).toBe(
      'Moderação: ontem (23/09) a fila passou da meta de 24 h',
    );
    expect(mail(ontem(), fila({ pending: 1, overSla: 1 })).title).toBe(
      'Moderação: 1 denúncia espera há mais que a meta de 24 h',
    );
    expect(mail(ontem(), fila({ pending: 3, overSla: 3 })).title).toBe(
      'Moderação: 3 denúncias esperam há mais que a meta de 24 h',
    );
    expect(mail(ontem({ medianHours: 30 }), fila({ pending: 1, overSla: 1 })).title).toBe(
      'Moderação: meta de 24 h estourada ontem e agora',
    );
  });

  it('ontem: entradas, decididas com a mediana contra a meta, e o detector', () => {
    const [p1] = mail(ontem({ medianHours: 30.25, flagged: 2 }), fila()).paragraphs;
    expect(p1).toBe(
      'Ontem (23/09) entraram 4 denúncias e a fila decidiu 3 (2 com ação, 1 dispensada), levando 30,3 h na mediana para decidir, acima da meta de 24 h. O detector sinalizou 2 mensagens.',
    );
    expect(mail(ontem({ received: 1, medianHours: 6 }), fila()).paragraphs[0]).toBe(
      'Ontem (23/09) entrou 1 denúncia e a fila decidiu 3 (2 com ação, 1 dispensada), levando 6,0 h na mediana para decidir, dentro da meta de 24 h.',
    );
    expect(
      mail(ontem({ actioned: 0, dismissed: 0, medianHours: null, received: 0 }), fila())
        .paragraphs[0],
    ).toBe('Ontem (23/09) entraram 0 denúncias e a fila não decidiu nenhuma.');
    expect(mail(undefined, fila({ pending: 1, overSla: 1 })).paragraphs[0]).toBe(
      'Ontem (23/09) entraram 0 denúncias e a fila não decidiu nenhuma.',
    );
  });

  it('agora: vazia, só revisões, dentro da meta, ou quantas passaram (e em quantos itens)', () => {
    expect(mail(ontem({ medianHours: 30 }), fila()).paragraphs[1]).toBe('Agora a fila está vazia.');
    expect(mail(ontem({ medianHours: 30 }), fila({ pending: 2, reviews: 2 })).paragraphs[1]).toBe(
      'Agora a fila só tem 2 contas em revisão por reincidência, que não entram na meta.',
    );
    const recente = new Date(AGORA.getTime() - 2 * 3_600_000);
    expect(
      mail(ontem({ medianHours: 30 }), fila({ pending: 3, reviews: 1, oldestContent: recente }))
        .paragraphs[1],
    ).toBe(
      'Agora 2 denúncias esperam decisão; a mais antiga há 2,0 h, nenhuma passou da meta. Fora isso, 1 conta em revisão por reincidência, sem meta.',
    );
    const velha = new Date(AGORA.getTime() - 50 * 3_600_000);
    expect(
      mail(ontem(), fila({ pending: 4, oldestContent: velha, overSla: 3, overSlaItems: 2 }))
        .paragraphs[1],
    ).toBe(
      'Agora 4 denúncias esperam decisão; a mais antiga há 50,0 h e 3 passaram da meta, em 2 itens da fila.',
    );
    expect(
      mail(ontem(), fila({ pending: 1, oldestContent: velha, overSla: 1, overSlaItems: 1 }))
        .paragraphs[1],
    ).toBe('Agora 1 denúncia espera decisão; a mais antiga há 50,0 h e 1 passou da meta.');
  });

  it('meta alterada hoje entra como aviso; o rodapé diz a hora e onde desligar; o link vai ao painel', () => {
    const m = mail(ontem({ medianHours: 30 }), fila(), {
      slaChangedAt: new Date('2026-09-24T10:30:00Z'),
      slaHours: 8,
      digestHour: 9,
    });
    expect(m.paragraphs).toHaveLength(4);
    expect(m.paragraphs[2]).toBe('A meta de 8 h foi alterada hoje às 07:30.');
    expect(m.paragraphs[3]).toBe(
      'Este e-mail sai no máximo uma vez por dia, a partir das 9h de Brasília, e só quando a meta estoura. Para desligar: painel admin › Parâmetros da plataforma › Relatório da meta da moderação.',
    );
    expect(m.link).toBe(`${env.APP_URL.replace(/\/$/, '')}/admin#health-title`);
    expect(mail(ontem({ medianHours: 30 }), fila()).paragraphs).toHaveLength(3);
  });
});
