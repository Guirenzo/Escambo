import { inferDeadlineZone, timezoneOf } from '../../utils/timezone';

/** Os fusos de uma contratação, a partir das colunas que as leituras trazem (ADR 46 e 58). */
interface ZonedRow {
  freelancer_timezone?: string | null;
  client_timezone?: string | null;
}

export const freelancerZoneOf = (row: ZonedRow) => timezoneOf(row.freelancer_timezone);
export const clientZoneOf = (row: ZonedRow) => timezoneOf(row.client_timezone);

/**
 * O fuso em que uma data da contratação é um dia (ADR 58): aquele em que ela marca 23:59:59,
 * preferindo o de quem entrega e depois o do cliente; sem data, o de quem entrega. Calculado na
 * leitura, nunca gravado: um instante só é 23:59:59 num relógio, então não há o que guardar.
 */
export const dayZoneOf = (row: ZonedRow, at: Date | string | null | undefined) =>
  at
    ? inferDeadlineZone(new Date(at), [freelancerZoneOf(row), clientZoneOf(row)])
    : freelancerZoneOf(row);
