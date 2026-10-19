import type {
  AdminMetrics,
  AdminWithdrawal,
  CreditTransaction,
  CreditTransactionsPage,
  Withdrawal,
} from '@escambo/types';
import { describe, expect, it } from 'vitest';
import { openapiDocument } from './openapi';

/**
 * Documento OpenAPI da 1.44.0: prazo de saque (RN-035) e extrato de créditos com período (RF-047).
 * Os campos obrigatórios de cada schema são as chaves do tipo de @escambo/types que a API devolve.
 */
const { schemas } = openapiDocument.components;
const path = (p: string, method: string) => openapiDocument.paths[p][method];
const json = (p: string, method: string, status: string) =>
  path(p, method).responses[status]?.content?.['application/json'].schema;

const withdrawal: Withdrawal = {
  id: 1,
  amount: 50,
  status: 'requested',
  method: 'pix',
  maskedDestination: '••••test',
  createdAt: '2026-10-19T15:00:00.000Z',
  processedAt: null,
  dueAt: '2026-10-21T02:59:59.000Z',
};
const adminWithdrawal: AdminWithdrawal = {
  ...withdrawal,
  userId: 7,
  userUlid: 'U',
  userEmail: 'f@escambo.test',
  userName: null,
  destination: 'f@escambo.test',
  overdue: false,
};
const credit: CreditTransaction = {
  id: 1,
  amount: 50,
  balanceAfter: 50,
  reason: 'welcome',
  contractId: null,
  createdAt: '2026-10-19T15:00:00.000Z',
};
const creditPage: CreditTransactionsPage = { items: [credit], page: 1, limit: 20, hasMore: false };
const metrics: AdminMetrics = {
  users: 1,
  freelancers: 1,
  contracts: 0,
  completedContracts: 0,
  openDisputes: 0,
  platformFees: 0,
  inEscrow: 0,
  pendingWithdrawals: 1,
  pendingWithdrawalsAmount: 50,
  overdueWithdrawals: 0,
  depositsTotal: 0,
  usersBalance: 0,
  pendingDeletions: 0,
  supportOpen: 0,
  supportAwaitingReply: 0,
  supportSlaOverdue: 0,
};

describe('documento OpenAPI: prazo de saque (RN-035)', () => {
  it('Withdrawal, AdminWithdrawal e AdminMetrics exigem exatamente os campos dos tipos', () => {
    expect(schemas.Withdrawal.required).toEqual(Object.keys(withdrawal));
    expect(Object.keys(schemas.Withdrawal.properties)).toEqual(Object.keys(withdrawal));
    expect(schemas.AdminWithdrawal.required).toEqual(Object.keys(adminWithdrawal));
    expect(Object.keys(schemas.AdminWithdrawal.properties)).toEqual(Object.keys(adminWithdrawal));
    expect(schemas.AdminMetrics.required).toEqual(Object.keys(metrics));
  });

  it('dueAt é instante (ou null no legado) e explica o cálculo; overdue diz o que passou do prazo', () => {
    expect(schemas.Withdrawal.properties.dueAt).toMatchObject({
      type: 'string',
      format: 'date-time',
      nullable: true,
    });
    expect(schemas.Withdrawal.properties.dueAt.description).toContain('dia útil');
    expect(schemas.Withdrawal.properties.dueAt.description).toContain(
      'withdrawal_pix_business_days',
    );
    expect(schemas.AdminWithdrawal.properties.overdue.type).toBe('boolean');
    expect(schemas.Withdrawal.properties.status.enum).toEqual([
      'requested',
      'processing',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('pedir, listar e cancelar saque respondem com os schemas novos e os erros de cada um', () => {
    expect(json('/withdrawals', 'post', '201')).toEqual({
      $ref: '#/components/schemas/Withdrawal',
    });
    expect(Object.keys(path('/withdrawals', 'post').responses)).toEqual([
      '201',
      '400',
      '403',
      '422',
    ]);
    expect(path('/withdrawals', 'post').summary).toContain('withdrawal_bank_business_days');
    expect(json('/withdrawals', 'get', '200')).toEqual({
      $ref: '#/components/schemas/WithdrawalsPage',
    });
    expect(path('/withdrawals', 'get').parameters.map((p: { name: string }) => p.name)).toEqual([
      'page',
      'limit',
    ]);
    expect(json('/withdrawals/{id}/cancel', 'post', '200')).toEqual({
      $ref: '#/components/schemas/Withdrawal',
    });
  });

  it('a fila do admin é uma lista de AdminWithdrawal pelo prazo; as métricas contam os atrasados', () => {
    expect(json('/admin/withdrawals', 'get', '200')).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/AdminWithdrawal' },
    });
    expect(path('/admin/withdrawals', 'get').summary).toContain('pelo prazo');
    expect(path('/admin/withdrawals', 'get').parameters[0]).toMatchObject({
      name: 'status',
      in: 'query',
      schema: { default: 'open' },
    });
    expect(json('/admin/metrics', 'get', '200')).toEqual({
      $ref: '#/components/schemas/AdminMetrics',
    });
    expect(schemas.AdminMetrics.properties.overdueWithdrawals.type).toBe('integer');
  });

  it('os parâmetros públicos dizem o prazo por forma de recebimento', () => {
    expect(path('/settings/public', 'get').summary).toContain('withdrawalBusinessDays');
  });
});

describe('documento OpenAPI: extrato de créditos com período (RF-047)', () => {
  it('a página de créditos tem hasMore e lançamentos do tipo CreditTransaction', () => {
    expect(schemas.CreditTransactionsPage.required).toEqual(Object.keys(creditPage));
    expect(schemas.CreditTransactionsPage.properties.items.items).toEqual({
      $ref: '#/components/schemas/CreditTransaction',
    });
    expect(schemas.CreditTransaction.required).toEqual(Object.keys(credit));
    expect(json('/credits/transactions', 'get', '200')).toEqual({
      $ref: '#/components/schemas/CreditTransactionsPage',
    });
  });

  it('os mesmos parâmetros e erros do extrato de R$', () => {
    const names = (p: string) =>
      path(p, 'get').parameters.map((x: { name: string; schema: unknown }) => [x.name, x.schema]);
    expect(names('/credits/transactions')).toEqual(names('/wallet/transactions'));
    expect(names('/credits/transactions').map(([name]: [string]) => name)).toEqual([
      'page',
      'limit',
      'from',
      'to',
    ]);
    const op = path('/credits/transactions', 'get');
    expect(op.responses['400'].description).toContain('invalid_range');
    expect(op.responses['422'].description).toContain(
      'Informe um dia válido no formato AAAA-MM-DD',
    );
  });
});
