import { describe, expect, it } from 'vitest';
import {
  createDepositSchema,
  depositIdParamSchema,
  listDepositsSchema,
  webhookSchema,
} from './payments.schema';

/** O primeiro erro de validação do campo, ou undefined quando o valor passa. */
function issueOf(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? undefined : result.error!.issues[0]!.message;
}

/** Regras de entrada dos depósitos e do webhook: os limites exatos e o que é convertido. */
describe('payments.schema', () => {
  describe('createDepositSchema', () => {
    it('aceita de R$ 10,00 a R$ 50.000,00, com até duas casas, e assume PIX', () => {
      for (const amount of [10, 10.01, 19.99, 1234.56, 50_000]) {
        expect(createDepositSchema.parse({ amount })).toEqual({ amount, method: 'pix' });
      }
    });

    it('abaixo do mínimo e acima do máximo cada um tem a sua mensagem', () => {
      expect(issueOf(createDepositSchema.safeParse({ amount: 9.99 }))).toBe(
        'Depósito mínimo é R$ 10,00',
      );
      expect(issueOf(createDepositSchema.safeParse({ amount: 50_000.01 }))).toBe(
        'Depósito máximo é R$ 50.000,00',
      );
    });

    it('recusa fração de centavo, zero, negativo e valor que não é número', () => {
      for (const amount of [10.005, 100.001, 0, -10, '150', null, Number.NaN]) {
        expect(createDepositSchema.safeParse({ amount }).success).toBe(false);
      }
      expect(createDepositSchema.safeParse({}).success).toBe(false);
    });

    it('a única forma de depósito é PIX, e campo desconhecido é descartado', () => {
      expect(createDepositSchema.safeParse({ amount: 50, method: 'boleto' }).success).toBe(false);
      expect(createDepositSchema.parse({ amount: 50, method: 'pix', payerId: 99 })).toEqual({
        amount: 50,
        method: 'pix',
      });
    });
  });

  it('o id do depósito vem da URL como texto e vira inteiro positivo', () => {
    expect(depositIdParamSchema.parse({ id: '12' })).toEqual({ id: 12 });
    for (const id of ['0', '-1', '1.5', 'abc']) {
      expect(depositIdParamSchema.safeParse({ id }).success).toBe(false);
    }
    expect(depositIdParamSchema.safeParse({}).success).toBe(false);
  });

  it('a lista de depósitos começa na página 1 com 20 itens, e o limite vai até 100', () => {
    expect(listDepositsSchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(listDepositsSchema.parse({ page: '3', limit: '100' })).toEqual({ page: 3, limit: 100 });
    expect(listDepositsSchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listDepositsSchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listDepositsSchema.safeParse({ page: '0' }).success).toBe(false);
    expect(listDepositsSchema.safeParse({ page: '2.5' }).success).toBe(false);
  });

  describe('webhookSchema', () => {
    it('o gateway só avisa pago ou falhou; o nome do evento é opcional', () => {
      expect(webhookSchema.parse({ gatewayPaymentId: 'sim_ABC', status: 'paid' })).toEqual({
        gatewayPaymentId: 'sim_ABC',
        status: 'paid',
      });
      expect(
        webhookSchema.parse({
          event: 'charge.failed',
          gatewayPaymentId: 'sim_ABC',
          status: 'failed',
        }),
      ).toEqual({ event: 'charge.failed', gatewayPaymentId: 'sim_ABC', status: 'failed' });
      for (const status of ['pending', 'cancelled', 'refunded', 'PAID', undefined]) {
        expect(webhookSchema.safeParse({ gatewayPaymentId: 'sim_ABC', status }).success).toBe(
          false,
        );
      }
    });

    it('a referência da cobrança é obrigatória, não vazia, com até 100 caracteres; o evento, até 60', () => {
      const ok = (o: Record<string, unknown>) =>
        webhookSchema.safeParse({ gatewayPaymentId: 'sim_ABC', status: 'paid', ...o }).success;

      expect(ok({ gatewayPaymentId: 'x'.repeat(100) })).toBe(true);
      expect(ok({ gatewayPaymentId: 'x'.repeat(101) })).toBe(false);
      expect(ok({ gatewayPaymentId: '' })).toBe(false);
      expect(ok({ gatewayPaymentId: 123 })).toBe(false);
      expect(webhookSchema.safeParse({ status: 'paid' }).success).toBe(false);
      expect(ok({ event: 'e'.repeat(60) })).toBe(true);
      expect(ok({ event: 'e'.repeat(61) })).toBe(false);
    });
  });
});
