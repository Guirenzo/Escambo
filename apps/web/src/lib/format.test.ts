import { describe, expect, it } from 'vitest';
import {
  BARTER_STATUS_LABEL,
  brl,
  dateInputValue,
  deadlineInfo,
  displayName,
  dt,
  endOfDayIso,
  hm,
  STATUS_LABEL,
} from './format';

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

describe('prazo de entrega', () => {
  const now = new Date(2026, 8, 10, 15, 0, 0); // 10/09/2026 15:00 local

  it('deadlineInfo conta em dias de calendário e marca o tom', () => {
    expect(deadlineInfo(null)).toBeNull();
    expect(deadlineInfo(new Date(2026, 8, 20, 23, 59).toISOString(), now)).toMatchObject({
      daysLeft: 10,
      tone: 'ok',
      label: 'faltam 10 dias',
    });
    expect(deadlineInfo(new Date(2026, 8, 12, 23, 59).toISOString(), now)).toMatchObject({
      tone: 'soon',
      label: 'faltam 2 dias',
    });
    expect(deadlineInfo(new Date(2026, 8, 11, 23, 59).toISOString(), now)).toMatchObject({
      tone: 'soon',
      label: 'vence amanhã',
    });
    expect(deadlineInfo(new Date(2026, 8, 10, 23, 59).toISOString(), now)).toMatchObject({
      daysLeft: 0,
      tone: 'soon',
      label: 'vence hoje',
    });
    expect(deadlineInfo(new Date(2026, 8, 10, 9, 0).toISOString(), now)).toMatchObject({
      tone: 'late',
      label: 'venceu hoje',
    });
    expect(deadlineInfo(new Date(2026, 8, 8, 23, 59).toISOString(), now)).toMatchObject({
      daysLeft: -2,
      tone: 'late',
      label: 'atrasada há 2 dias',
    });
  });

  it('dateInputValue e endOfDayIso conversam com <input type="date"> no fuso local', () => {
    expect(dateInputValue(new Date(2026, 0, 5))).toBe('2026-01-05');
    const iso = endOfDayIso('2026-01-05');
    const d = new Date(iso);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([
      2026, 0, 5, 23, 59,
    ]);
  });
});
