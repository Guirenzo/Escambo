import { describe, expect, it } from 'vitest';
import {
  groupSecret,
  normalizeRecoveryCode,
  normalizeSecondFactor,
  normalizeTotp,
  recoveryCodesText,
} from './mfa';

/**
 * O que a tela confere antes de mandar um código à API (RF-090): só o formato. Se o código está
 * certo, quem decide é o servidor.
 */

describe('groupSecret', () => {
  it('separa a chave base32 em grupos de 4 para ler e digitar no app', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBe(
      'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP',
    );
  });

  it('o último grupo pode ser menor, e espaços que vierem junto não contam', () => {
    expect(groupSecret(' ABCD EFG HIJ ')).toBe('ABCD EFGH IJ');
    expect(groupSecret('')).toBe('');
  });
});

describe('normalizeTotp', () => {
  it('aceita 6 dígitos, com ou sem espaço no meio (como alguns apps mostram)', () => {
    expect(normalizeTotp('123456')).toBe('123456');
    expect(normalizeTotp(' 123 456 ')).toBe('123456');
  });

  it('recusa o que não são 6 dígitos', () => {
    for (const bad of ['', '12345', '1234567', '12a456', 'ABCD-EFGH']) {
      expect(normalizeTotp(bad)).toBeNull();
    }
  });
});

describe('normalizeRecoveryCode', () => {
  it('aceita XXXX-XXXX com ou sem hífen e espaço, e manda como foi digitado (sem as pontas)', () => {
    expect(normalizeRecoveryCode('ab12-cd34')).toBe('ab12-cd34');
    expect(normalizeRecoveryCode(' AB12CD34 ')).toBe('AB12CD34');
    expect(normalizeRecoveryCode('AB12 CD34')).toBe('AB12 CD34');
  });

  it('recusa código incompleto, comprido demais ou com símbolos', () => {
    for (const bad of ['', 'AB12-CD3', 'AB12-CD345', 'AB12_CD34', 'ÁB12-CD34']) {
      expect(normalizeRecoveryCode(bad)).toBeNull();
    }
  });
});

describe('normalizeSecondFactor', () => {
  it('o campo de "app ou recuperação" aceita os dois formatos', () => {
    expect(normalizeSecondFactor('123 456')).toBe('123456');
    expect(normalizeSecondFactor('ab12-cd34')).toBe('ab12-cd34');
    expect(normalizeSecondFactor('1234')).toBeNull();
  });
});

describe('recoveryCodesText', () => {
  it('o .txt diz de que conta são os códigos, quando foram gerados e lista um por linha', () => {
    const now = new Date('2026-10-20T15:00:00.000Z');
    const text = recoveryCodesText(['AAAA-1111', 'BBBB-2222'], 'ana@escambo.test', now);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Escambo: códigos de recuperação da verificação em duas etapas');
    expect(lines[1]).toBe('Conta: ana@escambo.test');
    expect(lines[2]).toBe(`Gerados em: ${now.toLocaleString('pt-BR')}`);
    expect(text).toContain(' 1. AAAA-1111\n 2. BBBB-2222\n');
    expect(text).toContain('Gerar códigos novos no Perfil invalida estes.');
  });

  it('sem e-mail conhecido, a linha da conta fica de fora', () => {
    const text = recoveryCodesText(['AAAA-1111'], undefined, new Date());
    expect(text).not.toContain('Conta:');
    expect(text.split('\n')[1]).toMatch(/^Gerados em: /);
  });
});
