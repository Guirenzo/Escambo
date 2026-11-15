import { env } from '../../config/env';
import { createCheckoutPreference } from './mercadopago';

/**
 * Gateway de pagamento (depósitos na carteira).
 *
 * A API fala com o gateway por esta interface, e PAYMENT_GATEWAY escolhe qual (ADR 73):
 *
 * - **Simulado** (padrão; demo, dev e testes): gera uma cobrança PIX sintaticamente válida (BR
 *   Code EMV com CRC16), confirmada pelo endpoint de simulação (PAYMENTS_SIMULATE) ou pelo webhook
 *   `POST /api/payments/webhook` (protegido por PAYMENT_WEBHOOK_SECRET).
 * - **Mercado Pago** (Checkout Pro, em sandbox com as credenciais de teste): a cobrança é uma
 *   página de pagamento do Mercado Pago (Pix, cartão ou boleto), e a confirmação chega pelo
 *   webhook assinado `POST /api/payments/webhook/mercadopago`.
 */

export interface GatewayCharge {
  /** Identificador da cobrança no gateway (chave de idempotência do webhook). */
  externalId: string;
  /** Payload PIX "copia e cola" (BR Code), quando o gateway devolve um (o simulado). */
  pixCode: string | null;
  /** Página de pagamento do gateway, quando a pessoa paga fora do app (o Mercado Pago). */
  checkoutUrl: string | null;
  expiresAt: Date;
  /**
   * Corpo original da resposta do provedor, quando há um (RF-050): guardado higienizado com a
   * cobrança, para auditoria. O simulado não tem provedor por trás e não preenche.
   */
  raw?: Record<string, unknown>;
}

export interface PaymentGateway {
  readonly name: string;
  createCharge(input: { amount: number; reference: string }): Promise<GatewayCharge>;
}

/** CRC16-CCITT (polinômio 0x1021, inicial 0xFFFF) exigido pelo BR Code do PIX. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Campo EMV: id (2 dígitos) + tamanho (2 dígitos) + valor. */
const emv = (id: string, value: string): string =>
  `${id}${String(value.length).padStart(2, '0')}${value}`;

/** Monta o payload PIX estático (BR Code) com valor, chave, beneficiário e txid. */
export function buildPixPayload(p: {
  key: string;
  amount: number;
  txid: string;
  merchant: string;
  city: string;
}): string {
  const txid = p.txid.replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const base =
    emv('00', '01') +
    emv('26', emv('00', 'br.gov.bcb.pix') + emv('01', p.key)) +
    emv('52', '0000') +
    emv('53', '986') +
    emv('54', p.amount.toFixed(2)) +
    emv('58', 'BR') +
    emv('59', p.merchant.slice(0, 25)) +
    emv('60', p.city.slice(0, 15)) +
    emv('62', emv('05', txid)) +
    '6304';
  return base + crc16(base);
}

export const SIMULATED_GATEWAY = 'simulado';
export const MERCADOPAGO_GATEWAY = 'mercadopago';

export const simulatedGateway: PaymentGateway = {
  name: SIMULATED_GATEWAY,
  async createCharge({ amount, reference }) {
    return {
      externalId: `sim_${reference}`,
      pixCode: buildPixPayload({
        key: 'pagamentos@escambo.demo',
        amount,
        txid: reference,
        merchant: 'ESCAMBO SERVICOS',
        city: 'JOINVILLE',
      }),
      checkoutUrl: null,
      expiresAt: new Date(Date.now() + env.DEPOSIT_EXPIRES_MINUTES * 60_000),
    };
  },
};

/**
 * Checkout Pro: a referência do depósito é o `external_reference` da preferência e o id da
 * cobrança aqui. O id do pagamento do Mercado Pago só existe quando a pessoa paga; o webhook o
 * traz, e a consulta dele devolve a nossa referência.
 */
export const mercadoPagoGateway: PaymentGateway = {
  name: MERCADOPAGO_GATEWAY,
  async createCharge({ amount, reference }) {
    const expiresAt = new Date(Date.now() + env.MERCADOPAGO_DEPOSIT_EXPIRES_HOURS * 3_600_000);
    const preference = await createCheckoutPreference({ amount, reference, expiresAt });
    return {
      externalId: reference,
      pixCode: null,
      checkoutUrl: preference.checkoutUrl,
      expiresAt,
      raw: preference.raw,
    };
  },
};

/** O gateway que PAYMENT_GATEWAY escolhe, lido a cada uso (os testes trocam o env). */
const selected = (): PaymentGateway =>
  env.PAYMENT_GATEWAY === 'mercadopago' ? mercadoPagoGateway : simulatedGateway;

/** Ponto único de troca do provedor: quem cria as cobranças novas. */
export const paymentGateway: PaymentGateway = {
  get name() {
    return selected().name;
  },
  createCharge: (input) => selected().createCharge(input),
};
