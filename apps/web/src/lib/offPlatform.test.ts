import { describe, expect, it } from 'vitest';
import { describeSignals, offPlatformSignals } from './offPlatform';

// Os mesmos exemplos do teste da API (apps/api/src/modules/messaging/off-platform.test.ts).
describe('aviso de negociação por fora ao digitar (ADR 45)', () => {
  it('acha Pix, telefone, WhatsApp e "por fora"', () => {
    expect(offPlatformSignals('Me paga no PIX por fora, meu zap é (47) 99999-0001')).toEqual([
      'pix',
      'phone',
      'whatsapp',
      'off_platform',
    ]);
    expect(offPlatformSignals('Chave Pix: ana@exemplo.com')).toEqual(['pix', 'email']);
    expect(offPlatformSignals('Manda no whats: 47 3333-1234')).toEqual(['phone', 'whatsapp']);
    expect(offPlatformSignals('Fora da plataforma sai sem taxa')).toEqual(['off_platform']);
    expect(offPlatformSignals('Meu CPF é 123.456.789-00')).toEqual(['pix']);
    expect(offPlatformSignals('celular 47999990001, combinar direto')).toEqual([
      'phone',
      'off_platform',
    ]);
  });

  it('não avisa por dinheiro, data, pedido ou o Pix do próprio Escambo', () => {
    expect(
      offPlatformSignals(
        'Já fiz o depósito no Escambo: orçamento de R$ 1.500,00 para o dia 15/09 às 14:30, pedido #2026091500. Obrigado, ficou ótimo!',
      ),
    ).toEqual([]);
    expect(offPlatformSignals('O saldo do Pix caiu na carteira, pode aceitar')).toEqual([]);
    expect(offPlatformSignals('CEP 89201-000, telefone fixo 4733331234')).toEqual([]);
    expect(offPlatformSignals('')).toEqual([]);
  });

  it('descreve os sinais em português', () => {
    expect(describeSignals(['pix', 'phone', 'whatsapp'])).toBe('Pix, telefone e WhatsApp');
    expect(describeSignals(['email'])).toBe('e-mail');
  });
});
