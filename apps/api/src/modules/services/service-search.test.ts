import { describe, expect, it } from 'vitest';
import { parseTextSearch, trimEdges } from './service-search';

/**
 * Como o texto da busca vira as três partes da consulta (RNF-004): o MATCH do FULLTEXT, os
 * "contém" das palavras que o índice não guarda e o prefixo da tag. Se o MySQL acha mesmo é da
 * integração (services-catalogo.int.test.ts).
 */
describe('parseTextSearch', () => {
  it('cada palavra é obrigatória (+) e vale como prefixo (*), em minúsculas', () => {
    expect(parseTextSearch('Design Logo')).toEqual({
      fulltext: '+design* +logo*',
      contains: [],
      tagPrefix: 'design logo',
    });
  });

  it('acento fica (a collation do banco compara sem acento); palavra repetida entra uma vez', () => {
    expect(parseTextSearch('Programação programação')).toMatchObject({
      fulltext: '+programação*',
      tagPrefix: 'programação programação',
    });
  });

  it('palavras vazias (do InnoDB e do português) ficam fora do MATCH, que zeraria a busca', () => {
    expect(parseTextSearch('aulas de inglês para a empresa')).toMatchObject({
      fulltext: '+aulas* +inglês* +empresa*',
      contains: [],
    });
    expect(parseTextSearch('the best com')).toMatchObject({ fulltext: '+best*', contains: [] });
  });

  it('palavra curta demais para o índice (menos de 3 letras) vira "contém", junto do MATCH', () => {
    expect(parseTextSearch('designer UX 3d')).toEqual({
      fulltext: '+designer*',
      contains: ['ux', '3d'],
      tagPrefix: 'designer ux 3d',
    });
  });

  it('sem nenhuma palavra que caiba no índice, é só "contém" (o fallback)', () => {
    expect(parseTextSearch('ux')).toEqual({ fulltext: null, contains: ['ux'], tagPrefix: 'ux' });
    expect(parseTextSearch('c++ c#')).toEqual({
      fulltext: null,
      contains: ['c++', 'c#'],
      tagPrefix: 'c++ c#',
    });
  });

  it('só palavras vazias: são elas que a pessoa procura, como "contém"', () => {
    expect(parseTextSearch('de para')).toEqual({
      fulltext: null,
      contains: ['de', 'para'],
      tagPrefix: 'de para',
    });
  });

  it('ponto, hífen, barra e apóstrofo separam as partes, como no InnoDB; o "_" faz parte da palavra', () => {
    expect(parseTextSearch('node.js e-commerce ui/ux snake_case d’água')).toEqual({
      fulltext: '+node* +commerce* +snake_case* +água*',
      // Com símbolo, a palavra inteira também é "contém": o MATCH acha, o LIKE confere o símbolo.
      // ui/ux não tem parte que o índice guarde: só o "contém".
      contains: ['node.js', 'e-commerce', 'ui/ux', 'snake_case', 'd’água'],
      tagPrefix: 'node.js e-commerce ui/ux snake_case d’água',
    });
  });

  it('o símbolo vale como texto: "100%" acha "100%off", não "1000off"', () => {
    expect(parseTextSearch('promo100%')).toMatchObject({
      fulltext: '+promo100*',
      contains: ['promo100%'],
    });
  });

  it('pontuação de frase e operadores nas pontas saem; "+" e "#" do fim ficam (c++, c#)', () => {
    expect(parseTextSearch('logo, site. "vetor" (marca)')).toEqual({
      fulltext: '+logo* +site* +vetor* +marca*',
      contains: [],
      tagPrefix: 'logo, site. "vetor" (marca)',
    });
    expect(parseTextSearch('dev c++ c#')).toMatchObject({
      fulltext: '+dev*',
      contains: ['c++', 'c#'],
    });
  });

  it('os operadores do BOOLEAN MODE nunca passam: só letras, números e _ de cada palavra entram', () => {
    const { fulltext, contains } = parseTextSearch(
      '-logo +site* "frase exata" (grupo) ~menos >mais <menor @3',
    );
    expect(fulltext).toBe('+logo* +site* +frase* +exata* +grupo* +menos* +mais* +menor*');
    expect(fulltext!.replace(/\+[\p{L}\p{N}_]+\*/gu, '').trim()).toBe('');
    expect(contains).toEqual(['3']);
  });

  it('só pontuação: procurada como veio, como "contém"', () => {
    expect(parseTextSearch('+-()')).toEqual({
      fulltext: null,
      contains: ['+-()'],
      tagPrefix: '+-()',
    });
  });

  it('palavra maior que o índice guarda (84 caracteres) vira "contém"', () => {
    const long = 'a'.repeat(85);
    expect(parseTextSearch(`site ${long}`)).toMatchObject({
      fulltext: '+site*',
      contains: [long],
    });
    expect(parseTextSearch('b'.repeat(84)).fulltext).toBe(`+${'b'.repeat(84)}*`);
  });
});

describe('trimEdges', () => {
  /** A regex que a função substituiu: o resultado tem de ser o mesmo. */
  const EDGES = /^[,;:!?.…"'“”‘’()[\]{}<>+\-~*@]+|[,;:!?.…"'“”‘’()[\]{}<>~*@-]+$/gu;
  const PIECES = ['a', 'c', '+', '-', '#', '.', '(', ')', '"', '…', '“', '%', '@', '~', 'é', '_'];

  it('tira das pontas o mesmo que a regex', () => {
    expect(trimEdges('(c++)')).toBe('c++');
    expect(trimEdges('+-()')).toBe('');
    expect(trimEdges('c#.')).toBe('c#');
    let seed = 7;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 5000; n++) {
      const len = Math.floor(next() * 10);
      const word = Array.from(
        { length: len },
        () => PIECES[Math.floor(next() * PIECES.length)],
      ).join('');
      expect(trimEdges(word)).toBe(word.replace(EDGES, ''));
    }
  });

  it('lê uma palavra longa de pontuação em tempo linear (S8786)', () => {
    const attack = `${'-'.repeat(100_000)}a${'-'.repeat(100_000)}x`;
    const start = performance.now();
    expect(trimEdges(attack)).toBe(attack.slice(100_000));
    expect(performance.now() - start).toBeLessThan(200);
  });
});
