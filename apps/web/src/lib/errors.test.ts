import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { errorMessage } from './errors';

/** RNF-028: o que chega à tela é o texto da API ou de uma regra nossa, nunca o erro técnico. */
describe('errorMessage', () => {
  const fallback = 'Não foi possível salvar';

  it('falha da API: a mensagem dela, já em português', () => {
    const error = new ApiRequestError('Saldo insuficiente para o saque', 402, 'insufficient_funds');
    expect(errorMessage(error, fallback)).toBe('Saldo insuficiente para o saque');
  });

  it('falha de rede vinda do cliente HTTP: a mensagem de sem conexão', () => {
    const error = new ApiRequestError(
      'Sem conexão com o servidor. Confira sua internet e tente de novo.',
      0,
      'network_error',
    );
    expect(errorMessage(error, fallback)).toBe(
      'Sem conexão com o servidor. Confira sua internet e tente de novo.',
    );
  });

  it('regra do próprio app (Error simples): a mensagem escrita por nós', () => {
    expect(errorMessage(new Error('Permissão de avisos negada no navegador'), fallback)).toBe(
      'Permissão de avisos negada no navegador',
    );
  });

  it.each([
    ['TypeError', new TypeError('Failed to fetch')],
    ['TypeError de código', new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['SyntaxError', new SyntaxError('Unexpected token < in JSON at position 0')],
    [
      'DOMException',
      new DOMException('Registration failed - permission denied', 'NotAllowedError'),
    ],
  ])('erro técnico (%s) vira o texto de reserva', (_kind, error) => {
    expect(errorMessage(error, fallback)).toBe(fallback);
  });

  it.each([
    ['texto solto', 'falhou'],
    ['nada', undefined],
    ['objeto', { message: 'parece erro' }],
    ['Error sem mensagem', new Error('')],
    ['Error só com espaços', new Error('   ')],
  ])('o que não é erro com mensagem (%s) vira o texto de reserva', (_kind, error) => {
    expect(errorMessage(error, fallback)).toBe(fallback);
  });
});
