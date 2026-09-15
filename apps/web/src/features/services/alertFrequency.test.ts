import { describe, expect, it } from 'vitest';
import {
  ALERT_FREQUENCY_OPTIONS,
  alertFrequencyLabel,
  alertNotice,
  DEFAULT_ALERT_FREQUENCY,
} from './alertFrequency';

describe('frequência do alerta de busca salva (ADR 37)', () => {
  it('oferece as três frequências da API, da mais rápida para a mais espaçada', () => {
    expect(ALERT_FREQUENCY_OPTIONS.map((o) => o.value)).toEqual(['instant', 'hourly', 'daily']);
    expect(ALERT_FREQUENCY_OPTIONS.map((o) => o.value)).toContain(DEFAULT_ALERT_FREQUENCY);
  });

  it('rótulo e aviso acompanham a frequência escolhida', () => {
    expect(alertFrequencyLabel('instant')).toBe('Na hora');
    expect(alertFrequencyLabel('daily')).toBe('Uma vez por dia');
    expect(alertNotice('instant')).toMatch(/assim que aparecer/);
    expect(alertNotice('hourly')).toMatch(/uma vez por hora/);
    expect(alertNotice('daily')).toMatch(/resumo por dia/);
  });
});
