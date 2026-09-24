import { describe, expect, it } from 'vitest';
import { emailPreferenceSchema } from './notifications.schema';

/** O PUT parcial das preferências de aviso aceita a janela inteira ou null, nunca meia janela. */
describe('preferências de aviso: janela de silêncio (ADR 54)', () => {
  it('aceita a janela, o null e a combinação com os outros campos', () => {
    expect(emailPreferenceSchema.parse({ quietHours: { start: 22, end: 7 } })).toEqual({
      quietHours: { start: 22, end: 7 },
    });
    expect(emailPreferenceSchema.parse({ quietHours: null })).toEqual({ quietHours: null });
    expect(
      emailPreferenceSchema.parse({
        timezone: 'America/Manaus',
        quietHours: { start: 13, end: 14 },
      }),
    ).toEqual({ timezone: 'America/Manaus', quietHours: { start: 13, end: 14 } });
  });

  it('recusa início igual ao fim, com a frase que diz como desligar', () => {
    const r = emailPreferenceSchema.safeParse({ quietHours: { start: 7, end: 7 } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(
      'Início e fim iguais não formam uma janela de silêncio; para desligar, envie null',
    );
  });

  it('recusa meia janela, hora fora do dia e corpo vazio', () => {
    expect(emailPreferenceSchema.safeParse({ quietHours: { start: 22 } }).success).toBe(false);
    expect(emailPreferenceSchema.safeParse({ quietHours: { start: 24, end: 7 } }).success).toBe(
      false,
    );
    expect(emailPreferenceSchema.safeParse({ quietHours: { start: 2.5, end: 7 } }).success).toBe(
      false,
    );
    const vazio = emailPreferenceSchema.safeParse({});
    expect(vazio.success).toBe(false);
    expect(vazio.error?.issues[0]?.message).toContain('janela de silêncio');
  });
});
