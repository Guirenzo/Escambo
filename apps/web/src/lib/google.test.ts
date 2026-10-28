import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetGoogleRole,
  forgetSuggestedName,
  googleFailureMessage,
  googleRole,
  rememberGoogleRole,
  rememberSuggestedName,
  suggestedName,
} from './google';

/** As frases das recusas do Google e as lembranças desta aba (RF-002). */

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('googleFailureMessage', () => {
  it('cada motivo tem a sua frase, sem detalhe técnico; desconhecido vale como "falhou"', () => {
    expect(googleFailureMessage('negado')).toContain('cancelado');
    expect(googleFailureMessage('expirado')).toContain('expirou');
    expect(googleFailureMessage('email_nao_verificado')).toContain('não confirmou');
    expect(googleFailureMessage('conta_banida')).toBe('Conta banida. Fale com o suporte.');
    expect(googleFailureMessage('conta_excluida')).toContain('excluída');
    expect(googleFailureMessage('conta_vinculada')).toContain('outra conta Google');
    expect(googleFailureMessage('qualquer-coisa')).toBe(googleFailureMessage('falhou'));
    expect(googleFailureMessage(null)).toBeNull();
    expect(googleFailureMessage('')).toBeNull();
  });
});

describe('lembranças da aba', () => {
  it('o papel do cadastro fica até ser esquecido; do login (null), nada; outro valor não vale', () => {
    rememberGoogleRole('freelancer');
    expect(googleRole()).toBe('freelancer');
    expect(googleRole()).toBe('freelancer');
    forgetGoogleRole();
    expect(googleRole()).toBeNull();
    rememberGoogleRole('client');
    rememberGoogleRole(null);
    expect(googleRole()).toBeNull();
    sessionStorage.setItem('escambo:google-papel', 'admin');
    expect(googleRole()).toBeNull();
  });

  it('o nome sugerido é aparado e cortado; vazio não fica; esquecer apaga', () => {
    rememberSuggestedName(`  ${'A'.repeat(200)}  `);
    expect(suggestedName()).toHaveLength(150);
    rememberSuggestedName('   ');
    expect(suggestedName()).toBeNull();
    rememberSuggestedName('Ana Souza');
    expect(suggestedName()).toBe('Ana Souza');
    forgetSuggestedName();
    expect(suggestedName()).toBeNull();
    rememberSuggestedName(null);
    expect(suggestedName()).toBeNull();
  });

  it('sem armazenamento (aba privada, bloqueio), nada quebra: só não lembra', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    expect(() => rememberGoogleRole('client')).not.toThrow();
    expect(googleRole()).toBeNull();
    expect(() => forgetGoogleRole()).not.toThrow();
    expect(() => rememberSuggestedName('Ana')).not.toThrow();
    expect(suggestedName()).toBeNull();
  });
});
