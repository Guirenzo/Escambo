import { describe, expect, it } from 'vitest';
import type { ModerationHealthDay } from '@escambo/types';
import { moderationCsvFileName, moderationHistoryCsv } from './moderation.csv';

const day = (
  d: string,
  received: number,
  flagged: number,
  actioned: number,
  dismissed: number,
  medianHours: number | null,
): ModerationHealthDay => ({ day: d, received, flagged, actioned, dismissed, medianHours });

/** O CSV da série por dia (ADR 55) abre no Excel pt-BR e diz, por dia, se a meta estourou. */
describe('CSV da saúde da moderação', () => {
  it('uma linha por dia, com BOM, ponto e vírgula e vírgula decimal', () => {
    const csv = moderationHistoryCsv({
      history: [
        day('2026-09-22', 9, 5, 3, 1, 30.25),
        day('2026-09-23', 0, 0, 0, 0, null),
        day('2026-09-24', 4, 1, 2, 2, 4),
      ],
      slaHours: 24,
    });
    const [header, l1, l2, l3, fim] = csv.split('\r\n');
    expect(header).toBe(
      '﻿dia;denuncias_recebidas;sinalizacoes_automaticas;decididas_com_acao;dispensadas;decididas_total;mediana_horas;meta_horas;acima_da_meta',
    );
    expect(l1).toBe('2026-09-22;9;5;3;1;4;30,3;24;sim');
    // Dia sem decisão: mediana e "acima da meta" ficam vazios, e não "0" ou "nao".
    expect(l2).toBe('2026-09-23;0;0;0;0;0;;24;');
    expect(l3).toBe('2026-09-24;4;1;2;2;4;4,0;24;nao');
    expect(fim).toBe('');
  });

  it('a meta é a da plataforma no momento da exportação', () => {
    const csv = moderationHistoryCsv({
      history: [day('2026-09-24', 1, 0, 1, 0, 10)],
      slaHours: 8,
    });
    expect(csv).toContain(';10,0;8;sim');
  });

  it('o nome do arquivo leva as pontas da série', () => {
    expect(
      moderationCsvFileName([
        day('2026-09-18', 0, 0, 0, 0, null),
        day('2026-09-24', 1, 0, 1, 0, 2),
      ]),
    ).toBe('escambo-moderacao-2026-09-18_2026-09-24.csv');
    expect(moderationCsvFileName([day('2026-09-24', 0, 0, 0, 0, null)])).toBe(
      'escambo-moderacao-2026-09-24_2026-09-24.csv',
    );
  });
});
