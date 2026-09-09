import { describe, expect, it } from 'vitest';
import { responseHours } from './messaging.service';

describe('responseHours (amostra de tempo de resposta do freelancer)', () => {
  const clientId = 1;
  const now = new Date('2026-09-09T12:00:00Z');

  it('mede as horas desde a última mensagem do cliente', () => {
    const prev = { sender_id: clientId, created_at: new Date('2026-09-09T09:30:00Z') };
    expect(responseHours(prev, clientId, now)).toBe(2.5);
  });

  it('não conta quando a mensagem anterior é do próprio freelancer ou não existe', () => {
    expect(responseHours({ sender_id: 2, created_at: now }, clientId, now)).toBeNull();
    expect(responseHours(undefined, clientId, now)).toBeNull();
  });

  it('nunca devolve negativo (relógios fora de ordem) e arredonda a 2 casas', () => {
    const future = { sender_id: clientId, created_at: new Date('2026-09-09T12:30:00Z') };
    expect(responseHours(future, clientId, now)).toBe(0);
    const odd = { sender_id: clientId, created_at: new Date('2026-09-09T11:59:00Z') };
    expect(responseHours(odd, clientId, now)).toBe(0.02);
  });
});
