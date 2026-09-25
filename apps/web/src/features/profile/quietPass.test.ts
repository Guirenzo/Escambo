import { describe, expect, it } from 'vitest';
import { passPhrase, QUIET_PASS_DEFAULT, QUIET_PASS_ORDER, QUIET_PASS_TEXT } from './quietPass';

/** O que sai durante o silêncio (ADR 56): os textos da tela, espelho da lista da API. */
describe('o que sai no silêncio', () => {
  it('a lista da tela é a da API, e a opção marcada ao ligar é o prazo', () => {
    expect(QUIET_PASS_ORDER).toEqual(['deadline']);
    expect(QUIET_PASS_DEFAULT).toEqual(['deadline']);
    expect(QUIET_PASS_TEXT.deadline.label).toBe('Prazo vencido num trabalho que você entrega');
    expect(QUIET_PASS_TEXT.deadline.hint).toContain('prioridade alta');
  });

  it('passPhrase diz o que sai na hora; nada escolhido é null', () => {
    expect(passPhrase([])).toBeNull();
    expect(passPhrase(['deadline'])).toBe(
      'prazo vencido num trabalho que você entrega sai na hora',
    );
  });

  it('a mensagem de desmarcar diz que o prazo vem primeiro no aviso do fim do silêncio', () => {
    expect(QUIET_PASS_TEXT.deadline.off('07:00')).toBe(
      'Pronto: prazo vencido num trabalho que você entrega também espera, e vem primeiro no aviso das 07:00.',
    );
  });
});
