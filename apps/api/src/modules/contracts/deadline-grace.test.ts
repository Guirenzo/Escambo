import { describe, expect, it } from 'vitest';
import type { Contract } from '@escambo/types';
import { GRACE_MIN_LEFT_MS, graceState } from './deadline-grace';

/**
 * A carência da RN-029 como conta pura (ADR 56), espelho do SQL do job: corre com o prazo vencido,
 * o aviso de atraso dado e nenhum pedido pendente; menos de 15 min para agir é "acabando".
 */
const NOW = new Date('2026-09-26T12:00:00Z');
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
type Facts = Pick<Contract, 'status' | 'deadlineAt' | 'overdueNotifiedAt' | 'extension'>;
const c = (o: Partial<Facts> = {}): Facts => ({
  status: 'in_progress',
  deadlineAt: ago(30 * H),
  overdueNotifiedAt: ago(20 * H),
  extension: null,
  ...o,
});
const pendente = {
  status: 'pending' as const,
  deadlineAt: ago(-48 * H),
  reason: 'r',
  requestedAt: ago(H),
  resolvedAt: null,
};

describe('graceState (RN-029, ADR 56)', () => {
  it('parada: prazo no futuro, prazo agora, sem aviso, pedido pendente, entregue ou em disputa', () => {
    expect(graceState(c({ deadlineAt: ago(-H) }), 24, NOW)).toEqual({ phase: 'idle' });
    expect(graceState(c({ deadlineAt: NOW.toISOString() }), 24, NOW)).toEqual({ phase: 'idle' });
    expect(graceState(c({ overdueNotifiedAt: null }), 24, NOW)).toEqual({ phase: 'idle' });
    expect(graceState(c({ extension: pendente }), 24, NOW)).toEqual({ phase: 'idle' });
    expect(graceState(c({ status: 'delivered' }), 24, NOW)).toEqual({ phase: 'idle' });
    expect(graceState(c({ status: 'disputed' }), 24, NOW)).toEqual({ phase: 'idle' });
    expect(graceState(c({ deadlineAt: null }), 24, NOW)).toEqual({ phase: 'idle' });
  });

  it('correndo: termina 24 h depois do aviso, também em revisão e com a extensão recusada', () => {
    const endsAt = new Date(NOW.getTime() + 4 * H);
    expect(graceState(c(), 24, NOW)).toEqual({ phase: 'running', endsAt });
    expect(graceState(c({ status: 'revision_requested' }), 24, NOW)).toEqual({
      phase: 'running',
      endsAt,
    });
    expect(
      graceState(
        c({ extension: { ...pendente, status: 'declined', resolvedAt: ago(0) } }),
        24,
        NOW,
      ),
    ).toEqual({ phase: 'running', endsAt });
  });

  it('borda: exatamente 15 min para agir ainda é correndo; menos, ou já acabou, é acabando', () => {
    expect(GRACE_MIN_LEFT_MS).toBe(15 * 60_000);
    expect(graceState(c({ overdueNotifiedAt: ago(23.75 * H) }), 24, NOW).phase).toBe('running');
    expect(graceState(c({ overdueNotifiedAt: ago(23.75 * H + 1) }), 24, NOW).phase).toBe('ending');
    expect(graceState(c({ overdueNotifiedAt: ago(25 * H) }), 24, NOW)).toEqual({
      phase: 'ending',
      endsAt: new Date(NOW.getTime() - H),
    });
  });

  it('a carência vem do painel do admin: 1 h com o aviso de 30 min atrás ainda corre', () => {
    expect(graceState(c({ overdueNotifiedAt: ago(0.5 * H) }), 1, NOW)).toEqual({
      phase: 'running',
      endsAt: new Date(NOW.getTime() + 0.5 * H),
    });
  });
});
