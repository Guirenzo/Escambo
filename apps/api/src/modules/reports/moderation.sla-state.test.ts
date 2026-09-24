import { describe, expect, it } from 'vitest';
import { isDue, MAX_ATTEMPTS, nextState, parseState, RETRY_AFTER_MS } from './moderation.sla-state';

// 09:00 em Brasília.
const HOJE = new Date('2026-09-24T12:00:00Z');
const ANTES = new Date(HOJE.getTime() - RETRY_AFTER_MS);
const HA_POUCO = new Date(HOJE.getTime() - RETRY_AFTER_MS + 60_000);

const estado = (over: Partial<ReturnType<typeof nextState>> = {}) => ({
  day: '2026-09-24',
  at: ANTES.toISOString(),
  breached: false,
  slaHours: 24,
  recipients: 1,
  delivered: 0,
  attempts: 0,
  ...over,
});

/** A marca do relatório diário da meta (ADR 55): quando conferir de novo e o que gravar. */
describe('parseState', () => {
  it('lê o JSON gravado e completa o que faltar; lixo ou vazio vale como nunca conferiu', () => {
    expect(parseState(null)).toBeNull();
    expect(parseState('')).toBeNull();
    expect(parseState('{nope')).toBeNull();
    expect(parseState('{"day":"2026-09-24"}')).toBeNull();
    expect(parseState(JSON.stringify({ day: '2026-09-24', at: ANTES.toISOString() }))).toEqual(
      estado({ recipients: 0, slaHours: 0 }),
    );
    expect(parseState(JSON.stringify(estado({ breached: true, attempts: 2 })))).toEqual(
      estado({ breached: true, attempts: 2 }),
    );
  });
});

describe('isDue', () => {
  it('sem marca ou com marca de outro dia de Brasília: conferir', () => {
    expect(isDue(null, HOJE)).toBe(true);
    expect(isDue(estado({ day: '2026-09-23' }), HOJE)).toBe(true);
    // 02:00Z de amanhã ainda é hoje em Brasília: não é dia novo.
    expect(isDue(estado(), new Date('2026-09-25T02:00:00Z'))).toBe(false);
  });

  it('dia já conferido sem estouro não reabre, mesmo com a meta alterada depois', () => {
    expect(isDue(estado(), HOJE)).toBe(false);
    expect(isDue(estado({ slaHours: 8 }), HOJE)).toBe(false);
  });

  it('sem admin encontrado: tenta de novo depois de uma hora', () => {
    expect(isDue(estado({ recipients: 0 }), HOJE)).toBe(true);
    expect(isDue(estado({ recipients: 0, at: HA_POUCO.toISOString() }), HOJE)).toBe(false);
  });

  it('meta estourada e nenhuma entrega aceita: até três tentativas, uma por hora', () => {
    const falhou = estado({ breached: true, attempts: 1 });
    expect(isDue(falhou, HOJE)).toBe(true);
    expect(isDue({ ...falhou, at: HA_POUCO.toISOString() }, HOJE)).toBe(false);
    expect(isDue({ ...falhou, attempts: MAX_ATTEMPTS }, HOJE)).toBe(false);
    // Uma entrega aceita fecha o dia.
    expect(isDue({ ...falhou, delivered: 1 }, HOJE)).toBe(false);
  });
});

describe('nextState', () => {
  it('dia novo zera entregas e tentativas; a tentativa só conta com estouro e destinatário', () => {
    expect(
      nextState(estado({ day: '2026-09-23', delivered: 2, attempts: 3 }), HOJE, false, 24, 2),
    ).toEqual({
      day: '2026-09-24',
      at: HOJE.toISOString(),
      breached: false,
      slaHours: 24,
      recipients: 2,
      delivered: 0,
      attempts: 0,
    });
    expect(nextState(null, HOJE, true, 24, 2).attempts).toBe(1);
    expect(nextState(null, HOJE, true, 24, 0).attempts).toBe(0);
  });

  it('mesmo dia: soma a tentativa e guarda o que já foi entregue', () => {
    const prev = estado({ breached: true, attempts: 1, delivered: 0 });
    expect(nextState(prev, HOJE, true, 8, 1)).toMatchObject({
      day: '2026-09-24',
      breached: true,
      slaHours: 8,
      attempts: 2,
      delivered: 0,
    });
  });
});
