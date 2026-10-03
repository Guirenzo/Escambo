/**
 * Avisos que podem nascer com menos de 24 h para agir (ADR 56 a 58): vêm primeiro no resumo do fim
 * do silêncio e no resumo diário por e-mail. O pedido de extensão entra porque a resposta pode ficar
 * a 6 h (piso da RN-028); os que abrem contagem de dias (proposta, entrega) e os que não têm prazo
 * correndo (revisão parada, aprovação automática) ficam na ordem de chegada.
 */
export const DEADLINE_FIRST_TYPES: ReadonlySet<string> = new Set([
  'contract_overdue',
  'deadline_extension_declined',
  'deadline_extension_expired',
  'deadline_extension_requested',
  'contract_proposal_reminder',
  'contract_deadline_reminder',
  'contract_approval_reminder',
  'contract_extension_reminder',
]);
