import { describe, expect, it } from 'vitest';
import { BARTER_STATUS_LABEL, brl, dt, hm, STATUS_LABEL } from './format';

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
