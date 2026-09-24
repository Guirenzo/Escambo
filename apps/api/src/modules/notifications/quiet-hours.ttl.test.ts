import { describe, expect, it } from 'vitest';
import { PUSH_TTL_MAX_SECONDS, PUSH_TTL_MIN_SECONDS, pushTtlSeconds } from './quiet-hours';

/**
 * TTL do Web Push até o próximo silêncio (ADR 54): o serviço de push não pode entregar de
 * madrugada, a um aparelho que estava offline, um aviso que saiu à tarde.
 */
describe('pushTtlSeconds (ADR 54)', () => {
  const noite = { start: 22, end: 7 };
  // 15:00 em Brasília = 18:00Z.
  const tarde = new Date('2026-09-14T18:00:00Z');

  it('sem janela, o teto de 12 horas', () => {
    expect(pushTtlSeconds('America/Sao_Paulo', null, tarde)).toBe(PUSH_TTL_MAX_SECONDS);
  });

  it('à tarde, vale até as 22:00 de hoje no fuso da conta', () => {
    expect(pushTtlSeconds('America/Sao_Paulo', noite, tarde)).toBe(7 * 3600);
    // O mesmo instante em Manaus é 14:00: uma hora a mais até as 22:00 de lá.
    expect(pushTtlSeconds('America/Manaus', noite, tarde)).toBe(8 * 3600);
  });

  it('perto do início, o piso de 15 minutos segura o aviso de quem está num túnel', () => {
    const quaseDez = new Date('2026-09-15T00:55:00Z'); // 21:55 em Brasília
    expect(pushTtlSeconds('America/Sao_Paulo', noite, quaseDez)).toBe(PUSH_TTL_MIN_SECONDS);
  });

  it('dentro da janela, o próximo início é o de amanhã, preso ao teto de 12 horas', () => {
    const madrugada = new Date('2026-09-15T02:00:00Z'); // 23:00 em Brasília
    expect(pushTtlSeconds('America/Sao_Paulo', noite, madrugada)).toBe(PUSH_TTL_MAX_SECONDS);
  });

  it('janela diurna: de manhã vale até o início dela', () => {
    const manha = new Date('2026-09-14T12:00:00Z'); // 09:00 em Brasília
    expect(pushTtlSeconds('America/Sao_Paulo', { start: 13, end: 14 }, manha)).toBe(4 * 3600);
  });
});
