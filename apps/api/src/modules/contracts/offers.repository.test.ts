import type { OfferMilestone, OfferOutcome } from '@escambo/types';
import type { PoolConnection } from 'mysql2/promise';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../test-support/fake-db';
import { lockWalletRows, lockWalletUsers, lockWallets } from '../wallet/wallet.locks';
import { setClockForTests } from '../../utils/clock';
import type { ContractRow } from './contracts.repository';
import { offerTerms } from './offers';
import {
  offerMilestones,
  offersRepository,
  toOffer,
  updateOfferMilestones,
  type OfferRow,
} from './offers.repository';

const { applyWalletEffect } = vi.hoisted(() => ({ applyWalletEffect: vi.fn() }));
vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);
vi.mock('../wallet/wallet.locks', () => ({
  lockWalletRows: vi.fn(),
  lockWalletUsers: vi.fn(),
  lockWallets: vi.fn(),
}));
vi.mock('../wallet/wallet.ledger', () => ({ applyWalletEffect }));

const NOW = new Date('2026-10-08T15:00:00.000Z');
const CREATED = new Date('2026-10-06T15:00:00.000Z');
const EXPIRES = new Date('2026-10-09T15:00:00.000Z');
const NEXT_EXPIRES = new Date('2026-10-10T15:00:00.000Z');
const OK = { affectedRows: 1 };
const conn = fakeDb.conn as unknown as PoolConnection;

const contract = (extra: Partial<Omit<ContractRow, 'constructor'>> = {}): ContractRow =>
  ({
    id: 31,
    client_id: 7,
    freelancer_id: 44,
    price: '1000.00',
    platform_fee: '150.00',
    freelancer_net: '850.00',
    fee_percentage: '15.00',
    offer_seq: 1,
    status: 'pending',
    payment_mode: 'cash',
    barter_agreement_id: null,
    deadline_at: null,
    proposal_expires_at: EXPIRES,
    created_at: CREATED,
    freelancer_timezone: 'America/Sao_Paulo',
    client_timezone: 'America/Manaus',
    ...extra,
  }) as ContractRow;

const offer = (extra: Partial<Omit<OfferRow, 'constructor'>> = {}): OfferRow =>
  ({
    id: 101,
    contract_id: 31,
    seq: 1,
    made_by: 'client',
    price: '1000.00',
    platform_fee: '150.00',
    freelancer_net: '850.00',
    deadline_at: null,
    milestones: null,
    message: null,
    respond_by: EXPIRES,
    outcome: 'open',
    created_at: CREATED,
    resolved_at: null,
    ...extra,
  }) as OfferRow;

const input = (row: ContractRow = contract(), price = 1200) => ({
  expected: row,
  terms: offerTerms({
    price,
    pct: row.payment_mode === 'credits' ? 0 : 15,
    mode: row.payment_mode === 'credits' ? 'credits' : 'cash',
  }),
  deadlineAt: null,
  respondBy: NEXT_EXPIRES,
  message: 'Ajuste do escopo e valor',
  note: 'Contraproposta enviada na rodada atual: valor e escopo ajustados',
  pct: row.payment_mode === 'credits' ? 0 : 15,
  uid: row.offer_seq === 2 ? row.client_id : row.freelancer_id,
  now: NOW,
});

/** Respostas da leitura sob lock, antes de qualquer efeito financeiro. */
function readOpen(
  row: ContractRow,
  current = offer({
    seq: row.offer_seq ?? 1,
    made_by: row.offer_seq === 2 ? 'freelancer' : 'client',
  }),
) {
  fakeDb.reply([row]);
  if ((row.offer_seq ?? 1) === 1) fakeDb.reply([current]);
  fakeDb.reply([current]);
}

function expectRollback() {
  expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.commit).not.toHaveBeenCalled();
  expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
}

function expectCommit() {
  expect(fakeDb.conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
  expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
  expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  fakeDb.reset();
  for (const lock of [lockWalletRows, lockWalletUsers, lockWallets])
    vi.mocked(lock).mockReset().mockResolvedValue(undefined);
  setClockForTests(NOW, { frozen: true });
  for (const fn of [fakeDb.conn.beginTransaction, fakeDb.conn.commit, fakeDb.conn.rollback])
    fn.mockReset().mockResolvedValue(undefined);
  applyWalletEffect.mockReset().mockResolvedValue(true);
});

afterEach(() => setClockForTests(null));

describe('snapshots de ofertas', () => {
  const milestones: OfferMilestone[] = [
    { id: 81, title: 'Entrega', amount: 1000, freelancerNet: 850, dueAt: null },
  ];

  it('usa a conexão da transação na leitura ordenada quando fornecida', async () => {
    const query = vi.fn().mockResolvedValue([[offer()], []]);
    const local = { query } as unknown as PoolConnection;
    expect(await offersRepository.list(31, local)).toEqual([offer()]);
    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM contract_offers WHERE contract_id = :id ORDER BY seq',
      { id: 31 },
    );
    expect(fakeDb.calls).toHaveLength(0);
  });

  it.each([milestones, JSON.stringify(milestones)])(
    'mapeia JSON textual ou decodificado sem perder o snapshot',
    (stored) => {
      const row = offer({
        milestones: stored,
        deadline_at: new Date('2026-10-20T02:59:59.000Z'),
        resolved_at: NOW,
        outcome: 'accepted',
      });
      expect(offerMilestones(row)).toEqual(milestones);
      expect(toOffer(row, contract())).toEqual({
        seq: 1,
        madeBy: 'client',
        price: 1000,
        platformFee: 150,
        freelancerNet: 850,
        deadlineAt: '2026-10-20T02:59:59.000Z',
        deadlineZone: 'America/Sao_Paulo',
        milestones,
        message: null,
        respondBy: EXPIRES.toISOString(),
        outcome: 'accepted',
        createdAt: CREATED.toISOString(),
        resolvedAt: NOW.toISOString(),
      });
    },
  );

  it('oferta inicial legada copia centavos, ids e valores históricos sem recalcular a taxa', async () => {
    const row = contract({
      price: '10.01',
      platform_fee: '1.50',
      freelancer_net: '8.51',
      fee_percentage: null,
      proposal_expires_at: null,
    });
    fakeDb.reply(
      [],
      [
        {
          id: 81,
          title: 'Primeira parte',
          amount: '5.00',
          freelancer_net: '4.25',
          due_at: new Date('2026-10-20T02:59:59.000Z'),
        },
        { id: 82, title: 'Restante', amount: '5.01', freelancer_net: '4.26', due_at: null },
      ],
      OK,
    );
    await offersRepository.ensureInitial(conn, row);
    const write = fakeDb.calls.find((call) => call.sql.startsWith('INSERT INTO contract_offers'))!;
    // O contrato já está travado: INSERT SELECT NOT EXISTS reintroduz gap locks
    // entre contratos distintos; o snapshot deve usar a inserção direta.
    expect(write.sql).toMatch(/\bVALUES\s*\(/);
    expect(write.sql).not.toMatch(/\bSELECT\b|\bNOT\s+EXISTS\b/);
    expect(write.params).toEqual({
      contractId: 31,
      seq: 1,
      madeBy: 'client',
      price: 10.01,
      fee: 1.5,
      net: 8.51,
      deadlineAt: null,
      respondBy: null,
      now: CREATED,
      message: null,
      milestones: JSON.stringify([
        {
          id: 81,
          title: 'Primeira parte',
          amount: 5,
          freelancerNet: 4.25,
          dueAt: '2026-10-20T02:59:59.000Z',
        },
        { id: 82, title: 'Restante', amount: 5.01, freelancerNet: 4.26, dueAt: null },
      ]),
    });
    expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
    expect(fakeDb.conn.commit).not.toHaveBeenCalled();
  });

  it('não duplica o snapshot inicial que já existe', async () => {
    fakeDb.reply([offer()]);
    await offersRepository.ensureInitial(conn, contract());
    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.sqls()[0]).toContain('SELECT * FROM contract_offers');
  });

  it.each([{ offer_seq: 2 }, { barter_agreement_id: 99 }])(
    'não inventa oferta inicial para negociação avançada ou troca: %j',
    async (extra) => {
      await offersRepository.ensureInitial(conn, contract(extra));
      expect(fakeDb.calls).toHaveLength(0);
    },
  );

  it.each<OfferOutcome>(['accepted', 'declined', 'withdrawn', 'expired', 'countered', 'closed'])(
    'só resolve oferta aberta como %s',
    async (outcome) => {
      fakeDb.reply(OK, { affectedRows: 0 });
      expect(await offersRepository.resolve(conn, 31, 2, outcome, NOW)).toBe(true);
      expect(await offersRepository.resolve(conn, 31, 2, outcome, NOW)).toBe(false);
      expect(fakeDb.calls[0]!.sql).toContain(
        "WHERE contract_id = :id AND seq = :seq AND outcome = 'open'",
      );
      expect(fakeDb.calls[0]!.params).toEqual({ id: 31, seq: 2, outcome, now: NOW });
    },
  );
});

describe('contraproposta atômica', () => {
  it('freelancer preserva reserva e termos do contrato até o aceite do cliente', async () => {
    const row = contract();
    readOpen(row);
    fakeDb.reply(OK, OK, OK, OK);
    expect(await offersRepository.counter(input(row))).toBe('ok');
    expectCommit();
    expect(applyWalletEffect).not.toHaveBeenCalled();
    const update = fakeDb.calls.find((call) => call.sql.startsWith('UPDATE contracts SET'))!;
    expect(update.sql).toContain(
      "WHERE id = :id AND status = 'pending' AND offer_seq = :seq AND price = :heldPrice",
    );
    expect(update.sql.split('WHERE')[0]).not.toMatch(
      /(?:^|,) (?:price|platform_fee|freelancer_net|deadline_at) =/,
    );
    expect(fakeDb.sqls().some((sql) => sql.startsWith('UPDATE contract_milestones'))).toBe(false);
    expect(
      fakeDb.calls.find((call) => call.sql.startsWith('INSERT INTO contract_offers'))!.params,
    ).toEqual({
      contractId: 31,
      seq: 2,
      madeBy: 'freelancer',
      price: 1200,
      fee: 180,
      net: 1020,
      deadlineAt: null,
      milestones: null,
      message: 'Ajuste do escopo e valor',
      respondBy: NEXT_EXPIRES,
      now: NOW,
    });
    expect(fakeDb.calls.at(-1)!.params).toEqual({
      id: 31,
      uid: 44,
      note: 'Contraproposta enviada na rodada atual: valor e escopo ajustados',
      now: NOW,
    });
    expect(fakeDb.calls[0]!.sql).toBe('SELECT * FROM contracts WHERE id = :id FOR UPDATE');
  });

  it.each([
    { price: 1200, balanceDelta: -200, pendingDelta: 200, reason: 'hold' },
    { price: 1000.01, balanceDelta: -0.01, pendingDelta: 0.01, reason: 'hold' },
    { price: 900, balanceDelta: 100, pendingDelta: -100, reason: 'hold_release' },
  ])(
    'cliente ajusta somente a diferença para R$ $price',
    async ({ price, balanceDelta, pendingDelta, reason }) => {
      const row = contract({ offer_seq: 2 });
      readOpen(row);
      fakeDb.reply(OK, OK, OK, OK);
      expect(await offersRepository.counter(input(row, price))).toBe('ok');
      expect(lockWallets).toHaveBeenCalledExactlyOnceWith(conn, [7], [7]);
      expect(vi.mocked(lockWallets).mock.invocationCallOrder[0]!).toBeLessThan(
        applyWalletEffect.mock.invocationCallOrder[0]!,
      );
      expectCommit();
      expect(applyWalletEffect).toHaveBeenCalledExactlyOnceWith(conn, {
        userId: 7,
        balanceDelta,
        pendingDelta,
        reason,
        contractId: 31,
      });
      const update = fakeDb.calls.find((call) => call.sql.startsWith('UPDATE contracts SET'))!;
      expect(update.sql).toContain(
        ', price = :price, platform_fee = :fee, freelancer_net = :net, deadline_at = :deadlineAt',
      );
      expect(update.params).toMatchObject({
        id: 31,
        seq: 2,
        nextSeq: 3,
        heldPrice: '1000.00',
        price,
        pct: 15,
      });
      expect(fakeDb.conn.query.mock.invocationCallOrder[0]).toBeLessThan(
        applyWalletEffect.mock.invocationCallOrder[0]!,
      );
      expect(applyWalletEffect.mock.invocationCallOrder[0]).toBeLessThan(
        fakeDb.conn.commit.mock.invocationCallOrder[0]!,
      );
    },
  );

  it('mesmo valor não cria lançamento de reserva', async () => {
    const row = contract({ offer_seq: 2 });
    readOpen(row);
    fakeDb.reply(OK, OK, OK, OK);
    expect(await offersRepository.counter(input(row, 1000))).toBe('ok');
    expect(applyWalletEffect).not.toHaveBeenCalled();
    expectCommit();
  });

  it('créditos não são debitados ou reservados antes do aceite', async () => {
    const row = contract({
      offer_seq: 2,
      payment_mode: 'credits',
      platform_fee: '0.00',
      freelancer_net: '1000.00',
      fee_percentage: '0.00',
    });
    readOpen(
      row,
      offer({ seq: 2, made_by: 'freelancer', platform_fee: '0.00', freelancer_net: '1000.00' }),
    );
    fakeDb.reply(OK, OK, OK, OK);
    expect(await offersRepository.counter(input(row))).toBe('ok');
    expect(applyWalletEffect).not.toHaveBeenCalled();
    expect(fakeDb.sqls().some((sql) => /UPDATE wallets|INSERT INTO credit_ledger/.test(sql))).toBe(
      false,
    );
    expect(
      fakeDb.calls.find((call) => call.sql.startsWith('INSERT INTO contract_offers'))!.params,
    ).toMatchObject({ price: 1200, fee: 0, net: 1200 });
    expectCommit();
  });

  it.each([
    undefined,
    contract({ status: 'accepted' }),
    contract({ offer_seq: 3 }),
    contract({ price: '999.99' }),
    contract({ proposal_expires_at: NOW }),
    contract({ proposal_expires_at: new Date(NOW.getTime() - 1) }),
  ])('contrato ausente, alterado ou expirado não gera efeitos (%#)', async (fresh) => {
    fakeDb.reply(fresh ? [fresh] : []);
    expect(await offersRepository.counter(input())).toBe('changed');
    expect(fakeDb.calls).toHaveLength(1);
    expect(applyWalletEffect).not.toHaveBeenCalled();
    expectRollback();
  });

  it.each([
    { outcome: 'accepted' as const },
    { made_by: 'client' as const },
    { respond_by: NOW },
    { respond_by: new Date(NOW.getTime() - 1) },
    { respond_by: null },
  ])('oferta sob lock rejeita estado/autor/validade inconsistentes: %j', async (extra) => {
    const row = contract({ offer_seq: 2 });
    readOpen(row, offer({ seq: 2, made_by: 'freelancer', ...extra }));
    expect(await offersRepository.counter(input(row))).toBe('changed');
    expect(fakeDb.calls).toHaveLength(2);
    expect(applyWalletEffect).not.toHaveBeenCalled();
    expectRollback();
  });

  it('oferta 2 ausente não é substituída por snapshot fictício', async () => {
    const row = contract({ offer_seq: 2 });
    fakeDb.reply([row], []);
    expect(await offersRepository.counter(input(row))).toBe('changed');
    expectRollback();
    expect(fakeDb.sqls().some((sql) => sql.startsWith('INSERT'))).toBe(false);
  });

  it('saldo insuficiente aborta antes da mudança de oferta e do histórico', async () => {
    const row = contract({ offer_seq: 2 });
    readOpen(row);
    applyWalletEffect.mockResolvedValue(false);
    expect(await offersRepository.counter(input(row))).toBe('insufficient');
    expect(applyWalletEffect).toHaveBeenCalledTimes(1);
    expect(fakeDb.calls).toHaveLength(2);
    expectRollback();
  });

  it('falha do ledger da carteira propaga a causa e não deixa oferta publicada', async () => {
    const row = contract({ offer_seq: 2 });
    readOpen(row);
    const failure = new Error('Falha ao gravar o extrato');
    applyWalletEffect.mockRejectedValueOnce(failure);
    await expect(offersRepository.counter(input(row))).rejects.toBe(failure);
    expect(fakeDb.calls).toHaveLength(2);
    expectRollback();
  });

  it('validade cruzada durante a espera pela carteira desfaz a reserva e não publica oferta', async () => {
    const row = contract({ offer_seq: 2 });
    readOpen(row);
    fakeDb.reply(OK, OK, OK, OK);
    applyWalletEffect.mockImplementationOnce(async () => {
      setClockForTests(EXPIRES, { frozen: true });
      return true;
    });
    expect(await offersRepository.counter(input(row))).toBe('changed');
    expect(applyWalletEffect).toHaveBeenCalledTimes(1);
    expect(fakeDb.sqls().some((sql) => sql.startsWith('INSERT INTO contract_offers'))).toBe(false);
    expect(fakeDb.sqls().some((sql) => sql.startsWith('INSERT INTO contract_status_history'))).toBe(
      false,
    );
    expectRollback();
  });

  it('espera que consome a janela mínima de uma hora não publica contraproposta', async () => {
    const row = contract({ offer_seq: 2 });
    readOpen(row);
    fakeDb.reply(OK, OK, OK, OK);
    const proposed = { ...input(row), respondBy: new Date(NOW.getTime() + 3_600_000) };
    applyWalletEffect.mockImplementationOnce(async () => {
      setClockForTests(new Date(NOW.getTime() + 1000), { frozen: true });
      return true;
    });
    expect(await offersRepository.counter(proposed)).toBe('changed');
    expect(applyWalletEffect).toHaveBeenCalledTimes(1);
    expect(fakeDb.sqls().some((sql) => sql.startsWith('INSERT INTO contract_offers'))).toBe(false);
    expectRollback();
  });

  it('uma hora exata de resposta é suficiente quando nenhuma espera consome a janela', async () => {
    const row = contract({ offer_seq: 2 });
    readOpen(row);
    fakeDb.reply(OK, OK, OK, OK);
    expect(
      await offersRepository.counter({
        ...input(row),
        respondBy: new Date(NOW.getTime() + 3_600_000),
      }),
    ).toBe('ok');
    expectCommit();
  });

  it.each([[{ affectedRows: 0 }], [OK, { affectedRows: 0 }]])(
    'falha no contrato ou resolução desfaz o ajuste financeiro (%#)',
    async (...replies) => {
      const row = contract({ offer_seq: 2 });
      readOpen(row);
      fakeDb.reply(...replies);
      expect(await offersRepository.counter(input(row))).toBe('changed');
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(fakeDb.sqls().some((sql) => sql.startsWith('INSERT'))).toBe(false);
      expectRollback();
    },
  );

  it('marco já alterado aborta a nova oferta e desfaz a reserva', async () => {
    const row = contract({ offer_seq: 2 });
    readOpen(row);
    fakeDb.reply(OK, OK, { affectedRows: 0 });
    const proposed = input(row);
    proposed.terms = offerTerms({
      price: 1200,
      pct: 15,
      mode: 'cash',
      milestones: [
        { id: 81, title: 'Layout', amount: 600, dueAt: null },
        { id: 82, title: 'Publicação', amount: 600, dueAt: null },
      ],
    });
    expect(await offersRepository.counter(proposed)).toBe('changed');
    expect(applyWalletEffect).toHaveBeenCalledTimes(1);
    expect(fakeDb.sqls().some((sql) => sql.startsWith('INSERT'))).toBe(false);
    expectRollback();
  });

  it.each(['snapshot', 'histórico', 'commit'])(
    'falha no %s propaga a causa e faz rollback/release',
    async (where) => {
      const row = contract({ offer_seq: 2 });
      readOpen(row);
      const failure = new Error(`Falha no ${where}`);
      if (where === 'snapshot') fakeDb.reply(OK, OK, failure);
      else if (where === 'histórico') fakeDb.reply(OK, OK, OK, failure);
      else {
        fakeDb.reply(OK, OK, OK, OK);
        fakeDb.conn.commit.mockRejectedValueOnce(failure);
      }
      await expect(offersRepository.counter(input(row))).rejects.toBe(failure);
      expect(applyWalletEffect).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.release).toHaveBeenCalledTimes(1);
      expect(fakeDb.conn.commit).toHaveBeenCalledTimes(where === 'commit' ? 1 : 0);
    },
  );

  it('retry com sequência anterior não reserva de novo nem duplica oferta/histórico', async () => {
    const row = contract({ offer_seq: 2 });
    readOpen(row);
    fakeDb.reply(OK, OK, OK, OK, [contract({ offer_seq: 3, price: '1200.00' })]);
    const proposed = input(row);
    expect(await offersRepository.counter(proposed)).toBe('ok');
    expect(await offersRepository.counter(proposed)).toBe('changed');
    expect(applyWalletEffect).toHaveBeenCalledTimes(1);
    expect(
      fakeDb.sqls().filter((sql) => sql.startsWith('INSERT INTO contract_offers')),
    ).toHaveLength(1);
    expect(
      fakeDb.sqls().filter((sql) => sql.startsWith('INSERT INTO contract_status_history')),
    ).toHaveLength(1);
    expect(fakeDb.conn.commit).toHaveBeenCalledTimes(1);
    expect(fakeDb.conn.rollback).toHaveBeenCalledTimes(1);
    expect(fakeDb.conn.release).toHaveBeenCalledTimes(2);
  });
});

describe('termos dos mesmos marcos', () => {
  const terms = offerTerms({
    price: 1200,
    pct: 15,
    mode: 'cash',
    milestones: [
      { id: 81, title: 'Layout', amount: 400, dueAt: '2026-10-20T02:59:59.000Z' },
      { id: 82, title: 'Publicação', amount: 800, dueAt: null },
    ],
  });

  it('altera valores e datas pelos ids do contrato preservando títulos e ordem', async () => {
    fakeDb.reply(OK, OK);
    expect(await updateOfferMilestones(conn, 31, terms)).toBe(true);
    expect(fakeDb.calls.map((call) => call.params)).toEqual([
      {
        id: 31,
        milestoneId: 81,
        amount: 400,
        net: 340,
        dueAt: new Date('2026-10-20T02:59:59.000Z'),
      },
      { id: 31, milestoneId: 82, amount: 800, net: 680, dueAt: null },
    ]);
    for (const sql of fakeDb.sqls()) {
      expect(sql).toContain("WHERE id = :milestoneId AND contract_id = :id AND status = 'pending'");
      expect(sql).not.toMatch(/title =|sort_order =/);
    }
  });

  it('para no primeiro marco não pending e deixa o rollback ao chamador', async () => {
    fakeDb.reply({ affectedRows: 0 });
    expect(await updateOfferMilestones(conn, 31, terms)).toBe(false);
    expect(fakeDb.calls).toHaveLength(1);
    expect(fakeDb.conn.commit).not.toHaveBeenCalled();
    expect(fakeDb.conn.rollback).not.toHaveBeenCalled();
  });
});
