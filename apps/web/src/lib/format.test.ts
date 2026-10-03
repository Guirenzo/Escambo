import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  BARTER_STATUS_LABEL,
  brl,
  dateInputValue,
  DIGEST_HOURS,
  digestHourLabel,
  displayName,
  durationLabel,
  percentLabel,
  dt,
  formatAvailability,
  formatAvailableDays,
  formatBytes,
  formatHours,
  formatPeriods,
  hm,
  STATUS_LABEL,
} from './format';

describe('dayLabel', () => {
  it('mostra o dia da data sem hora como está, sem cair no dia anterior pelo UTC', () => {
    expect(dayLabel('2026-09-25')).toBe('25/09/2026');
    expect(dayLabel('2026-01-01')).toBe('01/01/2026');
  });
});

describe('format', () => {
  it('brl formata valores em reais (pt-BR)', () => {
    expect(brl(1200)).toMatch(/R\$\s?1\.200,00/);
    expect(brl(0)).toMatch(/R\$\s?0,00/);
    expect(brl(1275.5)).toMatch(/R\$\s?1\.275,50/);
  });

  it('dt formata uma data no padrão dd/mm/aaaa', () => {
    expect(dt('2026-01-15T10:00:00Z')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('hm formata hora:minuto', () => {
    expect(hm('2026-01-15T10:30:00Z')).toMatch(/^\d{2}:\d{2}$/);
  });

  it('STATUS_LABEL traduz status de contrato', () => {
    expect(STATUS_LABEL.completed).toBe('Concluído');
    expect(STATUS_LABEL.pending).toBe('Pendente');
    expect(STATUS_LABEL.disputed).toBe('Disputa');
  });

  it('BARTER_STATUS_LABEL traduz status de troca', () => {
    expect(BARTER_STATUS_LABEL.active).toBe('Em andamento');
    expect(BARTER_STATUS_LABEL.proposed).toBe('Proposta');
  });
});

describe('displayName', () => {
  it('usa o primeiro nome do perfil e cai na parte local do e-mail sem perfil', () => {
    expect(displayName('Bruno Silva', 'bruno@escambo.demo')).toBe('Bruno');
    expect(displayName('  Marina ', 'marina@escambo.demo')).toBe('Marina');
    expect(displayName(null, 'cliente@escambo.demo')).toBe('cliente');
    expect(displayName(undefined, undefined)).toBe('');
  });
});

describe('perfil: dias de atendimento e tempo de resposta', () => {
  it('formatAvailableDays resume dias seguidos e lista os demais', () => {
    expect(formatAvailableDays([1, 2, 3, 4, 5])).toBe('seg a sex');
    expect(formatAvailableDays([5, 1, 3])).toBe('seg, qua, sex');
    expect(formatAvailableDays([0, 6])).toBe('dom, sáb');
    expect(formatAvailableDays([])).toBe('');
    expect(formatAvailableDays(null)).toBe('');
  });

  it('formatHours fala em horas ou dias', () => {
    expect(formatHours(0.4)).toBe('menos de 1 h');
    expect(formatHours(2.4)).toBe('2 h');
    expect(formatHours(30)).toBe('1 dia');
    expect(formatHours(80)).toBe('3 dias');
  });
});

describe('dia do <input type="date">', () => {
  it('dateInputValue escreve o dia local como AAAA-MM-DD, com zero à esquerda', () => {
    expect(dateInputValue(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(dateInputValue(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });
});

describe('formatBytes', () => {
  it('B, KB inteiro, MB com uma casa até 10 e inteiro depois (vírgula pt-BR)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(870_400)).toBe('850 KB');
    expect(formatBytes(1_258_291)).toBe('1,2 MB');
    expect(formatBytes(12_582_912)).toBe('12 MB');
  });
});

describe('horário de atendimento (ADR 34)', () => {
  it('formatPeriods junta em português, na ordem do dia', () => {
    expect(formatPeriods(['evening', 'morning'])).toBe('manhã e noite');
    expect(formatPeriods(['afternoon'])).toBe('tarde');
    expect(formatPeriods(['evening', 'afternoon', 'morning'])).toBe('manhã, tarde e noite');
    expect(formatPeriods([])).toBe('');
  });

  it('formatAvailability: mesmos períodos em todos os dias, variados ou o dia todo', () => {
    const weekdays = [1, 2, 3, 4, 5];
    const same = Object.fromEntries(
      weekdays.map((d) => [String(d), ['morning', 'afternoon'] as const]),
    );
    expect(formatAvailability(weekdays, null)).toBe('seg a sex');
    expect(formatAvailability(weekdays, { ...same } as never)).toBe('seg a sex · manhã e tarde');
    expect(
      formatAvailability([1, 3, 5], { '1': ['evening'], '3': ['evening'], '5': ['evening'] }),
    ).toBe('seg, qua, sex · noite');
    expect(formatAvailability([0, 6], { '6': ['evening'] })).toBe('dom, sáb · horários variados');
    expect(formatAvailability([], { '1': ['morning'] })).toBe('');
  });
});

describe('saúde da moderação (ADR 47)', () => {
  it('tempo até decidir em minutos, horas ou dias; fração em porcentagem', () => {
    expect(durationLabel(null)).toBe('—');
    expect(durationLabel(0)).toBe('< 1 min');
    expect(durationLabel(0.02)).toBe('1 min');
    expect(durationLabel(0.6)).toBe('36 min');
    expect(durationLabel(3.4)).toBe('3 h');
    expect(durationLabel(47.4)).toBe('47 h');
    expect(durationLabel(47.6)).toBe('2 d');
    expect(durationLabel(52)).toBe('2 d 4 h');
    expect(durationLabel(72)).toBe('3 d');
    // Arredonda antes de dividir em dias: 71,6 h é "3 d", nunca "2 d 24 h".
    expect(durationLabel(71.6)).toBe('3 d');
    expect(durationLabel(71.4)).toBe('2 d 23 h');
    expect(percentLabel(null)).toBe('—');
    expect(percentLabel(0.667)).toBe('67%');
    expect(percentLabel(1)).toBe('100%');
  });
});

describe('hora do resumo do dia (ADR 42)', () => {
  it('oferece as 24 horas e mostra com dois dígitos', () => {
    expect(DIGEST_HOURS).toHaveLength(24);
    expect([DIGEST_HOURS[0], DIGEST_HOURS[23]]).toEqual([0, 23]);
    expect(digestHourLabel(7)).toBe('07:00');
    expect(digestHourLabel(20)).toBe('20:00');
  });
});
