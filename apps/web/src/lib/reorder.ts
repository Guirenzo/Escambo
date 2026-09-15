/** Listas que a pessoa arruma à mão, como o portfólio (ADR 43): as contas puras da ordem. */

/** Move o item de `index` um passo para cima (-1) ou para baixo (+1); na ponta, nada muda. */
export function moveItem<T>(list: readonly T[], index: number, step: -1 | 1): T[] {
  const target = index + step;
  const next = [...list];
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
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
