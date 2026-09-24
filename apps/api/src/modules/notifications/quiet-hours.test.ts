import { describe, expect, it } from 'vitest';
import { inQuietWindow, quietWindowLabel, quietWindowOf } from './quiet-hours';

describe('não perturbe (ADR 54)', () => {
  it('quietWindowOf: NULL, hora fora do dia ou início igual ao fim é desligado', () => {
    expect(quietWindowOf(null, null)).toBeNull();
    expect(quietWindowOf(22, null)).toBeNull();
    expect(quietWindowOf(undefined, 7)).toBeNull();
    expect(quietWindowOf(24, 7)).toBeNull();
    expect(quietWindowOf(-1, 7)).toBeNull();
    expect(quietWindowOf(7.5, 9)).toBeNull();
    expect(quietWindowOf(8, 8)).toBeNull(); // "o dia inteiro" ou "nunca": nem um nem outro
    expect(quietWindowOf(22, 7)).toEqual({ start: 22, end: 7 });
  });

  it('janela que cruza a meia-noite: silencia depois do início ou antes do fim', () => {
    const noite = { start: 22, end: 7 };
    expect(inQuietWindow(22, noite)).toBe(true); // começa inclusive
    expect(inQuietWindow(23, noite)).toBe(true);
    expect(inQuietWindow(0, noite)).toBe(true);
    expect(inQuietWindow(6, noite)).toBe(true);
    expect(inQuietWindow(7, noite)).toBe(false); // termina exclusive: às 07:00 já libera
    expect(inQuietWindow(12, noite)).toBe(false);
    expect(inQuietWindow(21, noite)).toBe(false);
  });

  it('janela diurna: silencia entre início e fim', () => {
    const almoco = { start: 13, end: 14 };
    expect(inQuietWindow(12, almoco)).toBe(false);
    expect(inQuietWindow(13, almoco)).toBe(true);
    expect(inQuietWindow(14, almoco)).toBe(false);
    expect(inQuietWindow(23, almoco)).toBe(false);
  });

  it('desligado nunca silencia, e a janela de 23 horas silencia quase tudo', () => {
    expect(inQuietWindow(3, null)).toBe(false);
    const quase = { start: 8, end: 7 };
    expect(inQuietWindow(7, quase)).toBe(false); // a única hora livre
    expect(inQuietWindow(8, quase)).toBe(true);
    expect(inQuietWindow(6, quase)).toBe(true);
  });

  it('o rótulo mostra as horas com dois dígitos', () => {
    expect(quietWindowLabel({ start: 22, end: 7 })).toBe('22:00 às 07:00');
    expect(quietWindowLabel({ start: 0, end: 6 })).toBe('00:00 às 06:00');
  });
});
