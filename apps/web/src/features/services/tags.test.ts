import { describe, expect, it } from 'vitest';
import { MAX_TAGS, normalizeTag, tagKey, tagProblem, tagSearchPath } from './tags';

/** As regras de tag da tela são as da API (RN-018): o que passa aqui, a API aceita. */
describe('tags do serviço (tela)', () => {
  it('normaliza como a API grava: trim, espaços reduzidos e minúsculas; o acento fica', () => {
    expect(normalizeTag('  React   Native ')).toBe('react native');
    expect(normalizeTag('PROGRAMAÇÃO')).toBe('programação');
    expect(tagKey('Programação')).toBe(tagKey('programacao'));
  });

  it('tamanho de 2 a 30 caracteres (contando letras, não bytes)', () => {
    expect(tagProblem('a', [])).toBe('Cada tag tem de 2 a 30 caracteres.');
    expect(tagProblem('x'.repeat(31), [])).toBe('Cada tag tem de 2 a 30 caracteres.');
    expect(tagProblem('ab', [])).toBeNull();
    expect(tagProblem('ç'.repeat(30), [])).toBeNull();
  });

  it('só letras, números, espaço e + # . / _ -', () => {
    expect(tagProblem('c++', [])).toBeNull();
    expect(tagProblem('ui/ux', [])).toBeNull();
    expect(tagProblem('<b>', [])).toBe('Use só letras, números, espaço e + # . / _ -');
  });

  it('repetida (sem caixa e sem acento) e acima de 10 não entram', () => {
    expect(tagProblem('programacao', ['programação'])).toBe(
      'A tag "programacao" já está na lista.',
    );
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `tag${i}`);
    expect(tagProblem('outra', full)).toBe('No máximo 10 tags por serviço.');
  });

  it('o link da tag é a busca por ela, com o texto codificado', () => {
    expect(tagSearchPath('ui/ux & c#')).toBe('/servicos?q=ui%2Fux%20%26%20c%23');
  });
});
