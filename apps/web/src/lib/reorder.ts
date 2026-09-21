/** Listas que a pessoa arruma à mão, como o portfólio (ADR 43): as contas puras da ordem. */

/** Leva o item de `from` para a posição `to` da lista final; fora da lista, nada muda. */
export function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** Move o item de `index` um passo para cima (-1) ou para baixo (+1); na ponta, nada muda. */
export const moveItem = <T>(list: readonly T[], index: number, step: -1 | 1): T[] =>
  moveTo(list, index, index + step);

/** Valor preso entre `min` e `max`. */
export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Arrastar (ADR 49): para onde vai o item arrastado, que agora ocupa de `top` a `bottom`. Subindo,
 * ele passa de um item de cima quando a borda de cima cruza o meio dele; descendo, quando a borda
 * de baixo cruza o meio de um de baixo. Pelas bordas, e não pelo meio, as duas pontas da lista
 * sempre são alcançáveis, mesmo com o arraste preso nelas e itens de alturas diferentes. `mids`
 * são os meios de cada item na posição de origem.
 */
export function dropIndex(
  mids: readonly number[],
  from: number,
  top: number,
  bottom: number,
): number {
  let index = 0;
  mids.forEach((mid, i) => {
    if (i < from && top > mid) index += 1; // continua abaixo deste
    if (i > from && bottom >= mid) index += 1; // já passou deste
  });
  return index;
}

/**
 * Quanto cada item que não está sendo arrastado desliza para abrir o espaço: os que ficam entre a
 * origem e o destino andam um passo (a altura do arrastado mais o espaço entre itens) no sentido
 * contrário ao arraste; os outros ficam.
 */
export function shiftFor(index: number, from: number, to: number, step: number): number {
  if (index === from) return 0;
  if (from < to && index > from && index <= to) return -step;
  if (from > to && index >= to && index < from) return step;
  return 0;
}

/**
 * Rolagem automática perto da borda da janela, em pixels por quadro: mais rápida quanto mais
 * perto da borda, negativa em cima, zero no meio.
 */
export function edgeSpeed(y: number, height: number, edge = 56, max = 14): number {
  if (y < edge) return -Math.ceil(((edge - Math.max(y, 0)) / edge) * max);
  if (y > height - edge) return Math.ceil(((Math.min(y, height) - (height - edge)) / edge) * max);
  return 0;
}

/** Aplica uma ordem de ids: ids desconhecidos são ignorados e itens fora da ordem ficam no fim. */
export function orderByIds<T extends { id: number }>(
  list: readonly T[],
  ids: readonly number[],
): T[] {
  const byId = new Map(list.map((item) => [item.id, item]));
  const ordered = ids.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
  const rest = list.filter((item) => !ids.includes(item.id));
  return [...ordered, ...rest];
}

/** "2º de 5": a posição como é anunciada para quem usa leitor de tela. */
export const positionLabel = (index: number, total: number): string => `${index + 1}º de ${total}`;
