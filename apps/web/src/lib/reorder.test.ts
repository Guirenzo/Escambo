import { describe, expect, it } from 'vitest';
import { moveItem, orderByIds, positionLabel } from './reorder';

describe('ordem do portfólio (ADR 43)', () => {
  it('move um passo para cima ou para baixo e não sai das pontas', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a'], 5, -1)).toEqual(['a']);
  });

  it('não altera a lista original', () => {
    const list = ['a', 'b'];
    moveItem(list, 1, -1);
    expect(list).toEqual(['a', 'b']);
  });

  it('aplica a ordem de ids, ignora id desconhecido e deixa no fim quem ficou de fora', () => {
    const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(orderByIds(list, [3, 1, 2]).map((i) => i.id)).toEqual([3, 1, 2]);
    expect(orderByIds(list, [2, 9]).map((i) => i.id)).toEqual([2, 1, 3]);
  });

  it('anuncia a posição contando do 1', () => {
    expect(positionLabel(0, 3)).toBe('1º de 3');
    expect(positionLabel(4, 5)).toBe('5º de 5');
  });
});
