import { describe, expect, it } from 'vitest';
import { csvCell, csvDocument, ptDecimal } from './csv';

/** O CSV que o Excel pt-BR abre certo (ADR 44 e 55): ponto e vírgula, vírgula decimal, BOM, CRLF. */
describe('csv', () => {
  it('csvCell só cita quando precisa e dobra as aspas', () => {
    expect(csvCell('simples')).toBe('simples');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell('linha\nquebrada')).toBe('"linha\nquebrada"');
    // CR solto também quebra a linha no Excel.
    expect(csvCell('linha\rquebrada')).toBe('"linha\rquebrada"');
  });

  it('ptDecimal usa vírgula e casas fixas; vazio para nulo', () => {
    expect(ptDecimal(1234.5, 2)).toBe('1234,50');
    expect(ptDecimal('7', 1)).toBe('7,0');
    expect(ptDecimal(null, 2)).toBe('');
    expect(ptDecimal(undefined, 1)).toBe('');
  });

  it('csvDocument monta BOM, cabeçalho e linhas com CRLF e CRLF final', () => {
    expect(
      csvDocument(
        ['a', 'b'],
        [
          [1, 'x;y'],
          [null, 2],
        ],
      ),
    ).toBe('﻿a;b\r\n1;"x;y"\r\n;2\r\n');
  });
});
