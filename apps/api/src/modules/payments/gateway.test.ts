import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import {
  buildPixPayload,
  crc16,
  mercadoPagoGateway,
  paymentGateway,
  simulatedGateway,
} from './gateway';
import { setMercadoPagoFetchForTests } from './mercadopago';

describe('BR Code do PIX (gateway simulado)', () => {
  it('crc16-ccitt bate com o vetor de referência', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('monta um payload EMV válido, com valor, chave e txid saneado', () => {
    const code = buildPixPayload({
      key: 'pagamentos@escambo.demo',
      amount: 150.5,
      txid: '01J-ABC def*123',
      merchant: 'ESCAMBO SERVICOS',
      city: 'JOINVILLE',
    });
    expect(code.startsWith('000201')).toBe(true); // payload format indicator
    expect(code).toContain('0014br.gov.bcb.pix0123pagamentos@escambo.demo');
    expect(code).toContain('5406150.50'); // valor com 2 casas
    expect(code).toContain('5802BR');
    expect(code).toContain('62160512' + '01JABCdef123'); // txid só alfanumérico
    // termina em 6304 + CRC de tudo que vem antes
    const body = code.slice(0, -4);
    expect(body.endsWith('6304')).toBe(true);
    expect(code.slice(-4)).toBe(crc16(body));
  });

  it('gateway simulado gera cobrança com id, código e validade futura', async () => {
    const charge = await simulatedGateway.createCharge({ amount: 80, reference: 'REF123' });
    expect(charge.externalId).toBe('sim_REF123');
    expect(charge.pixCode).toContain('540580.00');
    expect(charge.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('txid que fica vazio depois de saneado vira *** (o BR Code exige o campo preenchido)', () => {
    const code = buildPixPayload({
      key: 'pagamentos@escambo.demo',
      amount: 10,
      txid: '--- ***',
      merchant: 'ESCAMBO SERVICOS',
      city: 'JOINVILLE',
    });

    // Campo 62 (dados adicionais) com 7 caracteres: subcampo 05 (txid) de tamanho 3.
    expect(code).toContain('62070503***6304');
    expect(code.slice(-4)).toBe(crc16(code.slice(0, -4)));
  });

  it('respeita os limites do BR Code: txid com 25 caracteres, recebedor com 25 e cidade com 15', () => {
    const code = buildPixPayload({
      key: 'pagamentos@escambo.demo',
      amount: 1234.5,
      txid: '01JABCDEFGHJKMNPQRSTVWXYZ0', // 26 caracteres, como um ULID
      merchant: 'ESCAMBO SERVICOS DIGITAIS LTDA',
      city: 'SAO FRANCISCO DO SUL',
    });

    expect(code).toContain('54071234.50');
    expect(code).toContain('5925ESCAMBO SERVICOS DIGITAIS6015SAO FRANCISCO D');
    // O tamanho declarado de cada campo é o do valor já cortado.
    expect(code).toContain('6015SAO FRANCISCO D62290525' + '01JABCDEFGHJKMNPQRSTVWXYZ' + '6304');
    expect(code.slice(-4)).toBe(crc16(code.slice(0, -4)));
  });

  it('a cobrança simulada vence depois do prazo configurado, e o txid do código é a referência dela', async () => {
    const configured = env.DEPOSIT_EXPIRES_MINUTES;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T15:00:00.000Z'));
    env.DEPOSIT_EXPIRES_MINUTES = 45;
    try {
      const charge = await simulatedGateway.createCharge({ amount: 19.99, reference: 'REF123' });

      expect(charge.expiresAt).toEqual(new Date('2026-10-02T15:45:00.000Z'));
      expect(charge.externalId).toBe('sim_REF123');
      expect(charge.pixCode).toContain('540519.99');
      expect(charge.pixCode).toContain('0123pagamentos@escambo.demo');
      expect(charge.pixCode).toContain('62100506REF123');
    } finally {
      env.DEPOSIT_EXPIRES_MINUTES = configured;
      vi.useRealTimers();
    }
  });

  it('o provedor em uso é o simulado por padrão (ponto único de troca do gateway)', async () => {
    expect(env.PAYMENT_GATEWAY).toBe('simulated');
    expect(paymentGateway.name).toBe('simulado');
    const charge = await paymentGateway.createCharge({ amount: 10, reference: 'R1' });
    expect(charge).toMatchObject({ externalId: 'sim_R1', checkoutUrl: null });
  });
});

describe('gateway do Mercado Pago (Checkout Pro)', () => {
  afterEach(() => {
    env.PAYMENT_GATEWAY = 'simulated';
    setMercadoPagoFetchForTests(null);
    vi.useRealTimers();
  });

  it('PAYMENT_GATEWAY=mercadopago troca o provedor das cobranças novas, sem reiniciar nada', async () => {
    env.PAYMENT_GATEWAY = 'mercadopago';
    expect(paymentGateway.name).toBe('mercadopago');
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: 'pref-1',
        init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1',
        sandbox_init_point:
          'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1',
      }),
    );
    setMercadoPagoFetchForTests(fetchMock as unknown as typeof fetch);
    const charge = await paymentGateway.createCharge({ amount: 10, reference: 'R1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(charge.externalId).toBe('R1');
  });

  it('a cobrança é a página do Checkout Pro (init_point), vence no prazo do Mercado Pago e guarda a resposta', async () => {
    const configured = env.MERCADOPAGO_DEPOSIT_EXPIRES_HOURS;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T15:00:00.000Z'));
    env.MERCADOPAGO_DEPOSIT_EXPIRES_HOURS = 48;
    const body = {
      id: 'pref-2',
      init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-2',
      sandbox_init_point: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-2',
    };
    setMercadoPagoFetchForTests((async () => Response.json(body)) as unknown as typeof fetch);
    try {
      const charge = await mercadoPagoGateway.createCharge({ amount: 25.5, reference: 'REF9' });
      expect(charge).toEqual({
        externalId: 'REF9',
        pixCode: null,
        checkoutUrl: body.init_point,
        expiresAt: new Date('2026-10-04T15:00:00.000Z'),
        raw: body,
      });
    } finally {
      env.MERCADOPAGO_DEPOSIT_EXPIRES_HOURS = configured;
    }
  });
});
