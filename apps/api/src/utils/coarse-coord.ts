/**
 * Precisão da localização que sai para terceiros: 2 casas decimais de grau. 0,01° de latitude são
 * ~1,1 km (a longitude encolhe com o cosseno: ~1 km em Joinville), e o arredondamento erra no
 * máximo meia casa (~550 m). Basta para "perto de mim" e não aponta a casa de ninguém.
 */
export const COARSE_COORD_DECIMALS = 2;

const FACTOR = 10 ** COARSE_COORD_DECIMALS;

/**
 * Coordenada (graus) arredondada para ~1 km, para o perfil visto por outra pessoa ou sem sessão.
 * O dono, a busca e o ranking continuam com o valor exato no banco: só a resposta pública perde
 * precisão. Meio fica longe do zero nos dois hemisférios (o Math.round sozinho levaria -26,305
 * para -26,30 e 26,305 para 26,31), e o EPSILON corrige o binário de 1,005 (que é 1,00499…).
 * Nulo, ou o que não é número finito, vira null: sem localização, nunca NaN no JSON.
 */
export function coarseCoord(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded =
    (Math.sign(value) * Math.round(Math.abs(value) * FACTOR * (1 + Number.EPSILON))) / FACTOR;
  // -0,001 arredonda para -0, que o Object.is distingue de 0: sai 0, sem sinal.
  return rounded === 0 ? 0 : rounded;
}

/**
 * A mesma precisão no SQL da distância (busca de serviços e ranking "perto de mim"): o Haversine
 * e o corte do raio usam a coordenada do perfil já arredondada. Com a exata, quem mexesse no ponto
 * da busca de metro em metro veria o serviço entrar e sair do raio e acharia a casa do prestador,
 * por mais que a distância devolvida fosse arredondada. O ROUND do MySQL arredonda o meio para
 * longe do zero, como coarseCoord.
 */
export const coarseCoordSql = (column: string): string =>
  `ROUND(${column}, ${COARSE_COORD_DECIMALS})`;
