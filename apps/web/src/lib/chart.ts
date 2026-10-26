/** Contas puras dos gráficos (components/charts.tsx): o topo do eixo. */

/** Topo "redondo" do eixo: o menor 1, 2, 3, 4, 5, 6, 8 ou 10 × 10^k que cobre o valor. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  const exp = Math.floor(Math.log10(value));
  for (const m of [1, 2, 3, 4, 5, 6, 8, 10]) {
    const candidate = m * 10 ** exp;
    if (candidate >= value) return candidate;
  }
  return 10 ** (exp + 1);
}
