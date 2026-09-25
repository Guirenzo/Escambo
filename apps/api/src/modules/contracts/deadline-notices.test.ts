import { describe, expect, it } from 'vitest';
import { trimBody } from '../notifications/push.service';
import {
  extensionDeclinedNotice,
  overdueClientNotice,
  overdueFreelancerNotice,
  revisionNotice,
  type DeadlineFacts,
} from './deadline-notices';

/**
 * Os avisos de prazo palavra por palavra (ADR 56): o que diz, e quando pode sair durante o "não
 * perturbe" de quem marcou. A hora-limite vem primeiro porque o aviso no aparelho corta em 120.
 */
const f = (o: Partial<DeadlineFacts> = {}): DeadlineFacts => ({
  contractId: 3,
  title: 'Vídeo institucional',
  deadline: '25/09/2026',
  extensionFree: true,
  byMilestones: false,
  ...o,
});
const limit = '26/09/2026 às 00:03';
const running = { phase: 'running' as const, endsAt: new Date('2026-09-26T03:03:00Z') };
const ending = { phase: 'ending' as const, endsAt: new Date('2026-09-26T03:03:00Z') };
const idle = { phase: 'idle' as const };

describe('prazo estourado, cópia de quem entrega (RN-029)', () => {
  it('entrega única com a extensão livre: entregar ou pedir; sai no silêncio', () => {
    const n = overdueFreelancerNotice({ ...f(), limit });
    expect(n.passCategory).toBe('deadline');
    expect(n.params).toEqual({
      type: 'contract_overdue',
      title: 'Prazo estourado: Vídeo institucional',
      body: 'Até 26/09/2026 às 00:03: entregue ou peça a extensão (uma vez), senão a mediação abre sozinha. O prazo era 25/09/2026.',
      data: { contractId: 3 },
    });
  });

  it('entrega única com a extensão usada: só a entrega; sai no silêncio', () => {
    const n = overdueFreelancerNotice({ ...f({ extensionFree: false }), limit });
    expect(n.passCategory).toBe('deadline');
    expect(n.params.body).toBe(
      'Até 26/09/2026 às 00:03: registre a entrega, senão a mediação abre sozinha. A extensão já foi usada. O prazo era 25/09/2026.',
    );
  });

  it('por marcos com a extensão livre: só pedir a extensão segura a mediação; sai no silêncio', () => {
    const n = overdueFreelancerNotice({ ...f({ byMilestones: true }), limit });
    expect(n.passCategory).toBe('deadline');
    expect(n.params.body).toBe(
      'Até 26/09/2026 às 00:03: peça a extensão (uma vez), senão a mediação abre sozinha. O prazo era 25/09/2026.',
    );
  });

  it('por marcos com a extensão usada: nada a fazer, então não acorda ninguém', () => {
    const n = overdueFreelancerNotice({
      ...f({ byMilestones: true, extensionFree: false }),
      limit,
    });
    expect(n.passCategory).toBeUndefined();
    expect(n.params.body).toBe(
      'Sem extensão possível: a mediação abre sozinha a partir de 26/09/2026 às 00:03. Fale com o cliente pelo chat. O prazo era 25/09/2026.',
    );
  });

  it('a hora-limite e a ação cabem nos 120 caracteres do aviso no aparelho', () => {
    for (const o of [{}, { extensionFree: false }, { byMilestones: true }]) {
      const body = overdueFreelancerNotice({ ...f(o), limit }).params.body!;
      expect(trimBody(body)).toContain('senão a mediação abre sozinha');
    }
  });
});

describe('prazo estourado, cópia do cliente', () => {
  it('diz até quando, e nunca sai no silêncio', () => {
    const n = overdueClientNotice({ ...f(), limit });
    expect(n.passCategory).toBeUndefined();
    expect(n.params).toEqual({
      type: 'contract_overdue',
      title: 'Prazo estourado: Vídeo institucional',
      body: 'Sem entrega nem extensão até 26/09/2026 às 00:03, a mediação do Escambo abre sozinha. O prazo era 25/09/2026 e não houve entrega.',
      data: { contractId: 3 },
    });
  });
});

describe('extensão recusada (RN-028)', () => {
  it('sem carência correndo é o aviso de sempre, que espera o silêncio', () => {
    const n = extensionDeclinedNotice({ ...f(), grace: idle, limit: null });
    expect(n.passCategory).toBeUndefined();
    expect(n.params).toEqual({
      type: 'deadline_extension_declined',
      title: 'Extensão de prazo recusada',
      body: 'Vídeo institucional: o prazo original continua valendo.',
      data: { contractId: 3 },
    });
  });

  it('com a carência correndo: até quando, entregar ou pedir de novo; sai no silêncio', () => {
    const n = extensionDeclinedNotice({ ...f(), grace: running, limit });
    expect(n.passCategory).toBe('deadline');
    expect(n.params.title).toBe('Extensão recusada: Vídeo institucional');
    expect(n.params.body).toBe(
      'Prazo vencido. Até 26/09/2026 às 00:03: entregue ou peça a extensão de novo, senão a mediação abre sozinha. O prazo era 25/09/2026.',
    );
    expect(
      extensionDeclinedNotice({ ...f({ byMilestones: true }), grace: running, limit }).params.body,
    ).toBe(
      'Prazo vencido. Até 26/09/2026 às 00:03: peça a extensão de novo, senão a mediação abre sozinha. O prazo era 25/09/2026.',
    );
  });

  it('acabando: avisa sem acordar, e sem prometer que acabou', () => {
    const n = extensionDeclinedNotice({ ...f(), grace: ending, limit: null });
    expect(n.passCategory).toBeUndefined();
    expect(n.params.body).toBe(
      'O prazo era 25/09/2026 e a carência acaba em minutos: sem entrega nem novo pedido de extensão, a mediação abre sozinha.',
    );
    expect(
      extensionDeclinedNotice({ ...f({ byMilestones: true }), grace: ending, limit: null }).params
        .body,
    ).toBe(
      'O prazo era 25/09/2026 e a carência acaba em minutos: sem novo pedido de extensão, a mediação abre sozinha.',
    );
  });

  it('correndo sem a hora-limite (fuso ilegível) volta ao aviso de sempre, sem categoria', () => {
    const n = extensionDeclinedNotice({ ...f(), grace: running, limit: null });
    expect(n.passCategory).toBeUndefined();
    expect(n.params.title).toBe('Extensão de prazo recusada');
  });
});

describe('revisão pedida', () => {
  it('sem carência correndo é o aviso de sempre', () => {
    expect(revisionNotice({ ...f(), grace: idle, limit: null })).toEqual({
      params: {
        type: 'contract_revision',
        title: 'Revisão solicitada',
        body: null,
        data: { contractId: 3 },
      },
    });
  });

  it('com a carência correndo: nova entrega, com ou sem a extensão; sai no silêncio', () => {
    const livre = revisionNotice({ ...f(), grace: running, limit });
    expect(livre.passCategory).toBe('deadline');
    expect(livre.params.title).toBe('Revisão pedida: Vídeo institucional');
    expect(livre.params.body).toBe(
      'Prazo vencido. Até 26/09/2026 às 00:03: registre a nova entrega ou peça a extensão, senão a mediação abre sozinha. O prazo era 25/09/2026.',
    );
    expect(
      revisionNotice({ ...f({ extensionFree: false }), grace: running, limit }).params.body,
    ).toBe(
      'Prazo vencido. Até 26/09/2026 às 00:03: registre a nova entrega, senão a mediação abre sozinha. A extensão já foi usada. O prazo era 25/09/2026.',
    );
  });

  it('acabando: avisa sem acordar', () => {
    const n = revisionNotice({ ...f(), grace: ending, limit: null });
    expect(n.passCategory).toBeUndefined();
    expect(n.params.body).toBe(
      'O prazo era 25/09/2026 e a carência acaba em minutos: sem nova entrega nem pedido de extensão, a mediação abre sozinha.',
    );
    expect(
      revisionNotice({ ...f({ extensionFree: false }), grace: ending, limit: null }).params.body,
    ).toBe(
      'O prazo era 25/09/2026 e a carência acaba em minutos: sem nova entrega, a mediação abre sozinha.',
    );
  });
});
