import { BRAZIL_TIMEZONES, DEFAULT_TIMEZONE } from '../../utils/timezone';

/**
 * Os predicados SQL do prazo (ADR 57), num lugar só: toda leitura dos jobs e toda gravação que
 * age sobre o prazo repetem o MESMO texto, para a condição lida ser a condição gravada. O gêmeo
 * em TypeScript é `owesDelivery` (deadline-grace.ts), e um teste de integração confere os dois.
 */

/** O fuso da coluna, ou Brasília quando vazio ou fora da lista (users.timezone não tem CHECK). */
export const zoneOf = (col: string): string =>
  `(CASE WHEN ${col} IN (${BRAZIL_TIMEZONES.map((z) => `'${z}'`).join(', ')}) THEN ${col} ELSE '${DEFAULT_TIMEZONE}' END)`;

/**
 * Ainda há trabalho nunca entregue (R-VEZ): na entrega única, nenhuma entrega registrada; por
 * marcos, algum marco financiado sem `delivered_at`. Monotônico: uma vez entregue, o marco guarda
 * `delivered_at` mesmo voltando para revisão, então nada aqui volta a valer depois da entrega.
 */
export const neverDelivered = (a = 'c'): string => `(CASE
  WHEN EXISTS (SELECT 1 FROM contract_milestones m0 WHERE m0.contract_id = ${a}.id)
  THEN EXISTS (SELECT 1 FROM contract_milestones m1
                WHERE m1.contract_id = ${a}.id AND m1.status = 'funded' AND m1.delivered_at IS NULL)
  ELSE NOT EXISTS (SELECT 1 FROM deliveries d0 WHERE d0.contract_id = ${a}.id)
END)`;

/** Status em que o prazo de entrega corre: revisão e entrega não são mais a vez de quem entrega. */
export const DEADLINE_RUNNING_STATUSES = ['accepted', 'in_progress'] as const;

/** A RN-029 alcança a contratação: prazo correndo e trabalho nunca entregue. */
export const rn029Eligible = (a = 'c'): string =>
  `(${a}.status IN ('accepted', 'in_progress') AND ${a}.deadline_at IS NOT NULL AND ${neverDelivered(a)})`;

/** Há marco entregue ainda em aberto (esperando o cliente, ou em revisão): trava o cancelamento. */
export const openDeliveredMilestone = (a = 'c'): string =>
  `EXISTS (SELECT 1 FROM contract_milestones m2 WHERE m2.contract_id = ${a}.id
            AND m2.status IN ('funded', 'delivered') AND m2.delivered_at IS NOT NULL)`;

/**
 * Encerra o pedido de extensão pendente quando a contratação sai do alcance (entrega, cancelamento,
 * disputa, conclusão). `extension_resolved_at` vem ANTES de `extension_status`: o UPDATE de uma
 * tabela avalia o SET da esquerda para a direita, e a segunda atribuição já veria 'closed'.
 */
export const CLOSE_PENDING_EXTENSION = (a = 'c'): string =>
  `${a}.extension_resolved_at = IF(${a}.extension_status = 'pending', :now, ${a}.extension_resolved_at),
   ${a}.extension_status = IF(${a}.extension_status = 'pending', 'closed', ${a}.extension_status)`;
