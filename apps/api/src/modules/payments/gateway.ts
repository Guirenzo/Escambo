import { env } from '../../config/env';

/**
 * Gateway de pagamento (depósitos na carteira via PIX).
 *
 * A API fala com o gateway por esta interface; a única implementação neste estágio é a
 * SIMULADA: gera uma cobrança PIX sintaticamente válida (BR Code EMV com CRC16) e o pagamento
 * é confirmado pelo endpoint de simulação (PAYMENTS_SIMULATE) ou pelo webhook
 * (`POST /api/payments/webhook`, protegido por PAYMENT_WEBHOOK_SECRET) — exatamente o caminho
 * que um gateway real (Mercado Pago, Pagar.me…) usaria para avisar "pago".
 */

export interface PixCharge {
  /** Identificador da cobrança no gateway (chave de idempotência do webhook). */
  externalId: string;
  /** Payload "copia e cola" (BR Code). */
  pixCode: string;
  expiresAt: Date;
}

export interface PaymentGateway {
  readonly name: string;
  createPixCharge(input: { amount: number; reference: string }): Promise<PixCharge>;
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

export const simulatedGateway: PaymentGateway = {
  name: 'simulado',
  async createPixCharge({ amount, reference }) {
    return {
      externalId: `sim_${reference}`,
      pixCode: buildPixPayload({
        key: 'pagamentos@escambo.demo',
        amount,
        txid: reference,
        merchant: 'ESCAMBO SERVICOS',
        city: 'JOINVILLE',
      }),
      expiresAt: new Date(Date.now() + env.DEPOSIT_EXPIRES_MINUTES * 60_000),
    };
  },
};

/** Ponto único de troca do provedor (Mercado Pago, Pagar.me…). */
export const paymentGateway: PaymentGateway = simulatedGateway;
