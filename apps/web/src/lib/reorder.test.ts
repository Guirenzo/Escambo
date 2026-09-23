import { describe, expect, it } from 'vitest';
import {
  cancelLabel,
  clamp,
  dropIndex,
  dropLabel,
  edgeLabel,
  edgeSpeed,
  grabbedAt,
  grabLabel,
  keyTarget,
  moveItem,
  moveLabel,
  moveTo,
  orderByIds,
  positionLabel,
  shiftFor,
  stayLabel,
} from './reorder';

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

describe('arrastar para ordenar (ADR 49)', () => {
  it('moveTo leva o item para qualquer posição; fora da lista ou no mesmo lugar, nada muda', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveTo(['a', 'b', 'c', 'd'], 0, 3)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveTo(['a', 'b', 'c', 'd'], 1, 2)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveTo(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    expect(moveTo(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    expect(moveTo(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
  });

  it('dropIndex: a borda que avança passa do vizinho quando cruza o meio dele', () => {
    const mids = [25, 75, 125, 175]; // quatro linhas de 50 px, de 0 a 200
    expect(dropIndex(mids, 3, 150, 200)).toBe(3); // parado no lugar
    expect(dropIndex(mids, 3, 0, 50)).toBe(0); // preso no topo
    expect(dropIndex(mids, 3, 126, 176)).toBe(3); // subiu 24: a borda ainda não cruzou 125
    expect(dropIndex(mids, 3, 125, 175)).toBe(2); // subiu 25: cruzou o meio do terceiro
    expect(dropIndex(mids, 0, 150, 200)).toBe(3); // preso no fim
    expect(dropIndex(mids, 0, 24, 74)).toBe(0); // desceu 24: ainda não cruzou 75
    expect(dropIndex(mids, 0, 25, 75)).toBe(1); // desceu 25: cruzou o meio do segundo
  });

  it('dropIndex alcança as pontas com alturas diferentes, mesmo preso na borda', () => {
    // Alturas 50, 80 e 50: topos 0, 50 e 130; meios 25, 90 e 155; a lista vai até 180.
    const mids = [25, 90, 155];
    // O alto (80 px), preso no fim, vai de 100 a 180: o meio dele (140) nem chega ao da
    // última (155), mas a borda de baixo passa.
    expect(dropIndex(mids, 1, 100, 180)).toBe(2);
    // Preso no topo, vai de 0 a 80.
    expect(dropIndex(mids, 1, 0, 80)).toBe(0);
    // O último (50 px) preso no topo, de 0 a 50: passa dos dois.
    expect(dropIndex(mids, 2, 0, 50)).toBe(0);
  });

  it('shiftFor abre o espaço: quem fica entre a origem e o destino anda um passo ao contrário', () => {
    // Descendo do 0 para o 2: o 1 e o 2 sobem um passo; o 3 fica.
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2, 58))).toEqual([0, -58, -58, 0]);
    // Subindo do 3 para o 1: o 1 e o 2 descem um passo; o 0 fica.
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1, 58))).toEqual([0, 58, 58, 0]);
    // No lugar: ninguém se mexe.
    expect([0, 1, 2].map((i) => shiftFor(i, 1, 1, 58))).toEqual([0, 0, 0]);
  });

  it('clamp prende o arraste na lista; edgeSpeed rola mais rápido perto da borda', () => {
    expect(clamp(-300, -120, 60)).toBe(-120);
    expect(clamp(30, -120, 60)).toBe(30);
    expect(clamp(90, -120, 60)).toBe(60);
    expect(edgeSpeed(400, 800)).toBe(0);
    expect(edgeSpeed(0, 800)).toBe(-14);
    expect(edgeSpeed(28, 800)).toBe(-7);
    expect(edgeSpeed(55, 800)).toBe(-1);
    expect(edgeSpeed(800, 800)).toBe(14);
    expect(edgeSpeed(900, 800)).toBe(14);
    expect(edgeSpeed(-40, 800)).toBe(-14);
  });
});

describe('pegar e soltar pelo teclado (ADR 53)', () => {
  const lista = [
    { id: 7, title: 'Logo' },
    { id: 8, title: 'Site' },
    { id: 9, title: 'Cardápio' },
    { id: 10, title: 'Vitrine' },
  ];

  it('grabbedAt acha o item pelo id e prende o destino dentro da lista', () => {
    expect(grabbedAt(lista, 9, 1)).toEqual({ from: 2, to: 1 });
    // A lista pode encolher entre a tecla e o render: o destino nunca aponta para fora.
    expect(grabbedAt(lista, 9, -3)).toEqual({ from: 2, to: 0 });
    expect(grabbedAt(lista, 9, 40)).toEqual({ from: 2, to: 3 });
  });

  it('grabbedAt devolve null quando não há mais o que segurar', () => {
    expect(grabbedAt(lista, 999, 0)).toBeNull(); // removido em outra aba
    expect(grabbedAt([{ id: 7, title: 'Logo' }], 7, 0)).toBeNull(); // sobrou um: não há ordem
    expect(grabbedAt([], 7, 0)).toBeNull();
  });

  it('keyTarget: setas andam um passo, Home e End vão às pontas, o resto não é nosso', () => {
    expect(keyTarget(2, 4, 'ArrowUp')).toBe(1);
    expect(keyTarget(2, 4, 'ArrowDown')).toBe(3);
    expect(keyTarget(0, 4, 'ArrowUp')).toBe(0); // na ponta, fica
    expect(keyTarget(3, 4, 'ArrowDown')).toBe(3);
    expect(keyTarget(2, 4, 'Home')).toBe(0);
    expect(keyTarget(2, 4, 'End')).toBe(3);
    expect(keyTarget(0, 4, 'Tab')).toBeNull();
    expect(keyTarget(0, 4, 'a')).toBeNull();
    expect(keyTarget(0, 1, 'ArrowDown')).toBeNull(); // lista de um item não tem ordem
  });

  it('soltar no mesmo lugar não muda nada: moveTo é identidade', () => {
    expect(moveTo(lista, 2, 2)).toEqual(lista);
  });

  it('as frases do mesmo momento são distintas entre si', () => {
    // Região viva polida costuma não reanunciar texto idêntico: se duas frases coincidissem,
    // a pessoa ouviria silêncio justamente onde algo mudou.
    const frases = [
      grabLabel('Site', 1, 4),
      moveLabel(1, 4),
      edgeLabel(0, 4),
      edgeLabel(3, 4),
      dropLabel('Site', 1, 4),
      stayLabel('Site', 1, 4),
      cancelLabel('Site', 1, 4),
    ];
    expect(new Set(frases).size).toBe(frases.length);
  });

  it('a frase de soltar é a mesma dos outros dois caminhos, palavra por palavra', () => {
    // Setas (ADR 43), arraste (ADR 49) e teclado (ADR 53) falam pela mesma função.
    expect(dropLabel('Site', 2, 4)).toBe('Site agora é o 3º de 4.');
    expect(stayLabel('Site', 1, 4)).toBe('Site continua no 2º de 4.');
    expect(cancelLabel('Site', 1, 4)).toBe('Cancelado. Site continua no 2º de 4.');
    expect(grabLabel('Site', 1, 4)).toBe(
      'Pegou Site, 2º de 4. Setas movem, espaço solta, Esc ou Tab cancela.',
    );
    expect(edgeLabel(0, 4)).toBe('Começo da lista. 1º de 4.');
    expect(edgeLabel(3, 4)).toBe('Fim da lista. 4º de 4.');
    expect(moveLabel(2, 4)).toBe('3º de 4.');
  });
});
