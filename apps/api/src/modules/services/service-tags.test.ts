import { describe, expect, it } from 'vitest';
import { normalizeTag, tagKey, tagSlug, tagsSchema } from './service-tags';

/** Tags do serviço (RF-024, RN-018): normalização, chave de comparação e a validação da API. */
describe('tags do serviço', () => {
  it('normaliza: NFC, sem espaço nas pontas, espaços internos reduzidos a um, minúsculas; acento fica', () => {
    expect(normalizeTag('  React   Native ')).toBe('react native');
    expect(normalizeTag('PROGRAMAÇÃO')).toBe('programação');
    // "ç" decomposto (c + cedilha combinante) vira o mesmo "ç" composto.
    expect(normalizeTag('programação')).toBe('programação');
    expect(normalizeTag('\tUI\n/UX')).toBe('ui /ux');
  });

  it('a chave compara sem caixa e sem acento, como a collation do banco; o slug troca espaço por hífen', () => {
    expect(tagKey('Programação')).toBe('programacao');
    expect(tagKey('programacao')).toBe(tagKey('PROGRAMAÇÃO'));
    expect(tagSlug('Edição de Vídeo')).toBe('edicao-de-video');
    expect(tagSlug('c++')).toBe('c++');
  });

  it('o schema devolve as tags normalizadas, na ordem enviada', () => {
    expect(tagsSchema.parse([' Logo ', 'Node.js', 'C#'])).toEqual(['logo', 'node.js', 'c#']);
    expect(tagsSchema.parse([])).toEqual([]);
  });

  it('conta caracteres, não bytes: 30 letras acentuadas passam', () => {
    expect(tagsSchema.parse(['ã'.repeat(30)])).toEqual(['ã'.repeat(30)]);
    expect(tagsSchema.safeParse(['ã'.repeat(31)]).success).toBe(false);
  });

  it('aponta cada tag recusada pela posição', () => {
    const result = tagsSchema.safeParse(['ok', 'x', 'Ok', 'a<b']);
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => [i.path, i.message])).toEqual([
      [[1], 'Cada tag tem de 2 a 30 caracteres (RN-018)'],
      [[2], 'Tag repetida: "ok"'],
      [[3], 'Tag só com letras, números, espaço e + # . / _ -'],
    ]);
  });

  it('texto longo demais nem chega a ser normalizado', () => {
    const result = tagsSchema.safeParse(['x'.repeat(201)]);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toBe('Cada tag tem de 2 a 30 caracteres (RN-018)');
  });
});
