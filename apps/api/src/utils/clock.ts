/**
 * O relógio do fluxo de prazos (ADR 57). Services, repositórios e jobs de prazo leem a hora daqui,
 * e o SQL recebe `:now` do Node em vez de NOW(): assim a hora humana (9h às 20h30), o que se grava
 * e o que se compara saem do mesmo instante. Os testes de integração chamam a API no mesmo processo
 * e põem o relógio num horário diurno, para a CI não depender da hora em que roda.
 */

let offsetMs = 0;
let frozenAt: number | null = null;

/**
 * Sem a fração de segundo: o DATETIME do MySQL guarda até o segundo e ARREDONDA a fração, então
 * um instante gravado com 0,5 s ou mais ficaria no futuro do relógio (uma decisão das 12:00:05,6
 * gravada como 12:00:06 não passaria no "já aconteceu?" da mesma rodada).
 */
export const clock = {
  now: (): Date => {
    const t = frozenAt ?? Date.now() + offsetMs;
    return new Date(Math.floor(t / 1000) * 1000);
  },
};

/**
 * Só para testes: o relógio passa a marcar `at` e segue andando a partir dele (integração), ou
 * fica parado nele com `frozen` (unidade, para comparar o instante exato); null volta ao real.
 */
export function setClockForTests(at: Date | null, opts: { frozen?: boolean } = {}): void {
  frozenAt = at && opts.frozen ? at.getTime() : null;
  offsetMs = at && !opts.frozen ? at.getTime() - Date.now() : 0;
}
