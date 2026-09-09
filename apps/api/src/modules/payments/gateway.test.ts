import { describe, expect, it } from 'vitest';
import { buildPixPayload, crc16, simulatedGateway } from './gateway';

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
    const charge = await simulatedGateway.createPixCharge({ amount: 80, reference: 'REF123' });
    expect(charge.externalId).toBe('sim_REF123');
    expect(charge.pixCode).toContain('540580.00');
    expect(charge.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
