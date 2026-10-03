import { describe, expect, it } from 'vitest';
import { EMAILED_NOTIFICATION_TYPES } from '../mail/mail.service';
import { DEADLINE_FIRST_TYPES } from './deadline-types';
import { QUIET_PASS_BY_TYPE } from './push.service';

/**
 * Os avisos que podem nascer com menos de 24 h para agir vêm primeiro no resumo do fim do silêncio
 * e no resumo diário por e-mail (ADR 56 a 58). Um conjunto só para os dois resumos.
 */
describe('tipos que vêm primeiro nos resumos (ADR 58)', () => {
  it('são exatamente o atraso, a recusa, a expiração e o pedido de extensão, e os quatro lembretes', () => {
    expect([...DEADLINE_FIRST_TYPES].sort()).toEqual([
      'contract_approval_reminder',
      'contract_deadline_reminder',
      'contract_extension_reminder',
      'contract_overdue',
      'contract_proposal_reminder',
      'deadline_extension_declined',
      'deadline_extension_expired',
      'deadline_extension_requested',
    ]);
  });

  it('o pedido de extensão entra: a resposta pode ficar a 6 h (piso da RN-028)', () => {
    expect(DEADLINE_FIRST_TYPES.has('deadline_extension_requested')).toBe(true);
  });

  it('o que abre contagem de dias (proposta, entrega) e o que não tem prazo correndo (revisão parada, aprovação automática) fica na ordem de chegada', () => {
    for (const type of [
      'contract_proposal',
      'contract_delivered',
      'milestone_delivered',
      'contract_revision_stalled',
      'contract_auto_approved',
    ]) {
      expect(DEADLINE_FIRST_TYPES.has(type)).toBe(false);
    }
  });

  it('todos vão por e-mail e push: um tipo fora desse conjunto nunca chegaria ao resumo do silêncio', () => {
    for (const type of DEADLINE_FIRST_TYPES) {
      expect(EMAILED_NOTIFICATION_TYPES.has(type)).toBe(true);
    }
  });

  it('o único que pode furar o silêncio (o atraso, ADR 57) também vem primeiro', () => {
    const furam = Object.entries(QUIET_PASS_BY_TYPE)
      .filter(([, category]) => category !== null)
      .map(([type]) => type);
    expect(furam).toEqual(['contract_overdue']);
    for (const type of furam) expect(DEADLINE_FIRST_TYPES.has(type)).toBe(true);
  });
});
