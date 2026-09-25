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
    expect(vazio.error?.issues[0]?.message).toBe(
      'Informe a frequência dos e-mails, a hora do resumo, o fuso, a janela de silêncio ou o que sai durante ela',
    );
  });
});

/** O que sai durante o silêncio (ADR 56): o conjunto inteiro, da lista fechada, sem repetição. */
describe('preferências de aviso: o que sai no silêncio (ADR 56)', () => {
  it('aceita o conjunto vazio e o prazo, sozinhos ou com a janela', () => {
    expect(emailPreferenceSchema.parse({ quietPass: [] })).toEqual({ quietPass: [] });
    expect(emailPreferenceSchema.parse({ quietPass: ['deadline'] })).toEqual({
      quietPass: ['deadline'],
    });
    expect(
      emailPreferenceSchema.parse({ quietHours: { start: 22, end: 7 }, quietPass: ['deadline'] }),
    ).toEqual({ quietHours: { start: 22, end: 7 }, quietPass: ['deadline'] });
  });

  it('recusa categoria fora da lista, repetição, texto solto e null', () => {
    expect(emailPreferenceSchema.safeParse({ quietPass: ['security'] }).success).toBe(false);
    const dup = emailPreferenceSchema.safeParse({ quietPass: ['deadline', 'deadline'] });
    expect(dup.success).toBe(false);
    expect(dup.error?.issues[0]?.message).toBe('Categoria repetida no que sai durante o silêncio');
    expect(emailPreferenceSchema.safeParse({ quietPass: 'deadline' }).success).toBe(false);
    expect(emailPreferenceSchema.safeParse({ quietPass: null }).success).toBe(false);
  });
});
