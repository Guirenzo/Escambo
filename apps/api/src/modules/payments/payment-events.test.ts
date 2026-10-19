import { describe, expect, it, vi } from 'vitest';
import {
  chargeResponse,
  insertPaymentEvent,
  OMITTED,
  sanitizeGatewayPayload,
  shortText,
} from './payment-events';

/**
 * Histórico do gateway (RF-050): o corpo guardado é auditável, mas sem dado pessoal desnecessário
 * nem tamanho sem limite.
 */
describe('sanitizeGatewayPayload', () => {
  it('o corpo do webhook como o simulado manda passa inteiro', () => {
    const body = { event: 'payment.updated', gatewayPaymentId: 'sim_ABC', status: 'paid' };
    expect(sanitizeGatewayPayload(body)).toEqual(body);
  });

  it('dados de quem pagou e segredos saem como "[omitido]", em qualquer profundidade', () => {
    const body = {
      id: 'ch_1',
      amount: 150,
      paid: true,
      payer: { name: 'Maria', identification: { type: 'CPF', number: '12345678900' } },
      data: {
        customer_email: 'maria@x.test',
        Phone: '+5547999990000',
        devedor: { cpf: '1', nome: 'M' },
        bank_account: { agencia: '1', conta: '2' },
        pix_key: 'maria@x.test',
        authorization: 'Bearer x',
        items: [{ card: { last4: '4242' }, sku: 'deposito' }],
      },
    };

    expect(sanitizeGatewayPayload(body)).toEqual({
      id: 'ch_1',
      amount: 150,
      paid: true,
      payer: OMITTED,
      data: {
        customer_email: OMITTED,
        Phone: OMITTED,
        devedor: OMITTED,
        bank_account: OMITTED,
        pix_key: OMITTED,
        authorization: OMITTED,
        items: [{ card: OMITTED, sku: 'deposito' }],
      },
    });
  });

  it('teto de texto, de itens de lista, de chaves por objeto e de profundidade', () => {
    const long = 'x'.repeat(600);
    const many = Array.from({ length: 80 }, (_, i) => i);
    const wide = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i]));
    const deep = { a: { b: { c: { d: { e: { f: { g: 'fundo' } } } } } } };

    expect(sanitizeGatewayPayload(long)).toBe(`${'x'.repeat(500)}…`);
    expect(sanitizeGatewayPayload(many)).toHaveLength(50);
    expect(Object.keys(sanitizeGatewayPayload(wide) as object)).toHaveLength(100);
    expect(sanitizeGatewayPayload(deep)).toEqual({
      a: { b: { c: { d: { e: { f: '[truncado]' } } } } },
    });
  });

  it('só tipos de JSON: número não finito, undefined e função viram null', () => {
    expect(sanitizeGatewayPayload(null)).toBeNull();
    expect(sanitizeGatewayPayload(false)).toBe(false);
    expect(sanitizeGatewayPayload(Number.NaN)).toBeNull();
    expect(sanitizeGatewayPayload(undefined)).toBeNull();
    expect(sanitizeGatewayPayload(() => 1)).toBeNull();
    expect(sanitizeGatewayPayload({ n: Infinity, ok: 1.5 })).toEqual({ n: null, ok: 1.5 });
  });
});

describe('shortText', () => {
  it('corta no tamanho e só aceita texto não vazio', () => {
    expect(shortText('payment.updated', 7)).toBe('payment');
    expect(shortText('', 10)).toBeNull();
    expect(shortText(42, 10)).toBeNull();
    expect(shortText(undefined, 10)).toBeNull();
  });
});

describe('chargeResponse', () => {
  const charge = {
    externalId: 'sim_ABC',
    pixCode: '000201...6304ABCD',
    expiresAt: new Date('2026-10-02T15:30:00.000Z'),
  };

  it('a resposta da criação com o código PIX no topo e a validade em ISO', () => {
    expect(chargeResponse(charge)).toEqual({
      externalId: 'sim_ABC',
      pixCode: '000201...6304ABCD',
      expiresAt: '2026-10-02T15:30:00.000Z',
    });
  });

  it('o corpo do provedor, quando há, vai junto e higienizado', () => {
    expect(
      chargeResponse({ ...charge, raw: { id: 'gw', payer: { email: 'a@b.test' } } }),
    ).toMatchObject({ raw: { id: 'gw', payer: OMITTED } });
  });
});

describe('insertPaymentEvent', () => {
  it('grava pela conexão recebida, com o corpo em JSON (ou NULL sem corpo)', async () => {
    const db = { query: vi.fn().mockResolvedValue([{}, []]) };
    const base = {
      paymentId: 7,
      gateway: 'simulado',
      gatewayPaymentId: 'sim_ABC',
      source: 'webhook' as const,
      event: null,
      status: 'paid',
      outcome: 'applied' as const,
    };

    await insertPaymentEvent(db as never, { ...base, payload: { status: 'paid' } });
    await insertPaymentEvent(db as never, { ...base, payload: undefined });

    expect(db.query.mock.calls[0]![0]).toMatch(/INSERT INTO payment_events/);
    expect(db.query.mock.calls[0]![1]).toEqual({ ...base, payload: '{"status":"paid"}' });
    expect(db.query.mock.calls[1]![1]).toMatchObject({ payload: null });
  });
});
