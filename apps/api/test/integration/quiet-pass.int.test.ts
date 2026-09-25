import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runOverdueContracts } from '../../src/jobs/overdue-contracts';
import { runQuietPushSummary } from '../../src/jobs/quiet-push-summary';
import { notificationsService } from '../../src/modules/notifications/notifications.service';
import {
  simulatedPushProvider,
  type PushPayload,
  type PushSendOptions,
} from '../../src/modules/notifications/push.provider';
import { QUIET_PASS_CATEGORIES } from '../../src/modules/notifications/quiet-hours';
import { hourIn } from '../../src/utils/timezone';
import { fundWallet } from './wallet.helpers';

/**
 * O que sai durante o "não perturbe" (ADR 56) contra o MySQL real, com o provedor simulado
 * espionado: a escolha na conta (nula até a pessoa escolher, o banco fechando a lista), o prazo
 * estourado que sai na hora só para quem entrega e marcou (pelo job de verdade), a recusa e a
 * revisão que só saem com a carência correndo, e o resumo do fim do silêncio sem o que já saiu e
 * com os de prazo primeiro. O tempo é "andado" no banco (deadline_at, overdue_notified_at).
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const password = 'senha-integracao-123';
const DAY = 86_400_000;
let seq = 0;

interface Actor {
  id: number;
  token: string;
  endpoint: string;
}

async function actor(role: 'client' | 'freelancer'): Promise<Actor> {
  const email = `int_pass_${role}_${Date.now()}_${seq++}@escambo.test`;
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken, endpoint: '' };
}

const mod = (n: number): number => ((n % 24) + 24) % 24;

/** Liga um aparelho e uma janela de silêncio que cobre o agora (h-1 até h+2, em Brasília). */
async function silenced(a: Actor, quietPass?: string[]): Promise<Actor> {
  const endpoint = `https://push.escambo.test/pass-${a.id}-${seq++}`;
  await request(app)
    .post('/api/notifications/push')
    .set(auth(a.token))
    .send({ endpoint, p256dh: 'BChaveDoAparelho0000000000000000', auth: 'segredo123' })
    .expect(201);
  const h = hourIn('America/Sao_Paulo', new Date());
  await request(app)
    .put('/api/notifications/preferences')
    .set(auth(a.token))
    .send({ quietHours: { start: mod(h - 1), end: mod(h + 2) } })
    .expect(200);
  if (quietPass) {
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(a.token))
      .send({ quietPass })
      .expect(200);
  }
  return { ...a, endpoint };
}

const iso = (msFromNow: number): string => {
  const d = new Date(Date.now() + msFromNow);
  d.setMilliseconds(0);
  return d.toISOString();
};

async function contractFor(client: Actor, freelancer: Actor): Promise<number> {
  const res = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: `Logo ${seq++}`,
      description: 'Contratação do teste do que sai no silêncio',
      price: 50,
      deadlineAt: iso(5 * DAY),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await request(app)
    .post(`/api/contracts/${res.body.id}/accept`)
    .set(auth(freelancer.token))
    .expect(200);
  return res.body.id as number;
}

interface NotifRow {
  id: number;
  title: string;
  body: string | null;
  push_held_at: Date | null;
}
/** A notificação mais recente do tipo para a pessoa, esperando o aviso (que é void) chegar. */
async function latest(userId: number, type: string, contractId?: number): Promise<NotifRow> {
  let found: NotifRow | undefined;
  await expect
    .poll(
      async () => {
        const [rows] = await pool.query<(NotifRow & { length: number })[] & { length: number }>(
          `SELECT id, title, body, push_held_at FROM notifications
            WHERE user_id = :userId AND type = :type
              AND (:contractId IS NULL OR JSON_EXTRACT(data, '$.contractId') = :contractId)
            ORDER BY id DESC LIMIT 1`,
          { userId, type, contractId: contractId ?? null },
        );
        found = (rows as unknown as NotifRow[])[0];
        return found !== undefined;
      },
      { timeout: 5000 },
    )
    .toBe(true);
  return found!;
}

/** Espera o push decidir: retido (marca na notificação) ou enviado (chamada ao provedor). */
async function held(n: NotifRow): Promise<boolean> {
  let result = false;
  await expect
    .poll(
      async () => {
        const [rows] = await pool.query<({ push_held_at: Date | null } & { length: number })[]>(
          'SELECT push_held_at FROM notifications WHERE id = :id',
          { id: n.id },
        );
        const isHeld =
          (rows as unknown as { push_held_at: Date | null }[])[0]?.push_held_at != null;
        const sent = spy.mock.calls.some((c) => (c[1] as PushPayload).tag.endsWith(`:n${n.id}`));
        result = isHeld;
        return isHeld || sent;
      },
      { timeout: 5000 },
    )
    .toBe(true);
  return result;
}

const callsTo = (endpoint: string) =>
  spy.mock.calls.filter((c) => (c[0] as { endpoint: string }).endpoint === endpoint);

let spy: ReturnType<typeof vi.spyOn<typeof simulatedPushProvider, 'send'>>;
beforeEach(() => {
  spy = vi.spyOn(simulatedPushProvider, 'send');
});
afterEach(() => {
  spy.mockRestore();
});
afterAll(async () => {
  await pool.end();
});

describe('O que sai durante o silêncio (ADR 56)', () => {
  it('a escolha nasce nula, só muda por pedido explícito, fica na trilha e o banco fecha a lista', async () => {
    const freela = await actor('freelancer');
    const cliente = await actor('client');
    const me = async (a: Actor) =>
      (await request(app).get('/api/auth/me').set(auth(a.token)).expect(200)).body;
    const prefs = (a: Actor, body: unknown) =>
      request(app).put('/api/notifications/preferences').set(auth(a.token)).send(body);

    expect((await me(freela)).quietPass).toBeNull();
    const got = await request(app)
      .get('/api/notifications/preferences')
      .set(auth(freela.token))
      .expect(200);
    expect(got.body.quietPass).toBeNull();
    // Ligar a janela pela API não inventa a escolha: o padrão marcado é gesto da tela.
    expect(
      (await prefs(freela, { quietHours: { start: 22, end: 7 } }).expect(200)).body.quietPass,
    ).toBeNull();

    expect((await prefs(freela, { quietPass: ['deadline'] }).expect(200)).body.quietPass).toEqual([
      'deadline',
    ]);
    await expect
      .poll(
        async () => {
          const [rows] = await pool.query<({ new_value: unknown } & { length: number })[]>(
            `SELECT new_value FROM audit_logs WHERE user_id = :id AND action = 'push_quiet_pass_changed'
              ORDER BY id DESC LIMIT 1`,
            { id: freela.id },
          );
          const r = (rows as unknown as { new_value: unknown }[])[0];
          return r ? JSON.stringify(r.new_value) : '';
        },
        { timeout: 5000 },
      )
      .toContain('deadline');

    expect((await prefs(freela, { quietPass: [] }).expect(200)).body.quietPass).toEqual([]);
    expect((await me(freela)).quietPass).toEqual([]);
    await prefs(freela, { quietPass: ['security'] }).expect(422);
    await prefs(freela, { quietPass: ['deadline', 'deadline'] }).expect(422);
    await prefs(freela, { quietPass: null }).expect(422);
    // Desligar e religar a janela não mexe na escolha.
    await prefs(freela, { quietHours: null }).expect(200);
    await prefs(freela, { quietHours: { start: 23, end: 6 } }).expect(200);
    expect((await me(freela)).quietPass).toEqual([]);

    // O banco recusa categoria fora da lista (modo estrito) e o SET é o espelho da constante.
    await expect(
      pool.query(`UPDATE users SET push_quiet_pass = 'security' WHERE id = :id`, { id: freela.id }),
    ).rejects.toThrow();
    const [cols] = await pool.query<({ t: string } & { length: number })[]>(
      `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'push_quiet_pass'`,
    );
    expect((cols as unknown as { t: string }[])[0]?.t).toBe(
      `set(${QUIET_PASS_CATEGORIES.map((c) => `'${c}'`).join(',')})`,
    );

    // Só quem entrega trabalho vê a escolha.
    const push = async (a: Actor) =>
      (await request(app).get('/api/notifications/push').set(auth(a.token)).expect(200)).body;
    expect((await push(freela)).deliversWork).toBe(true);
    expect((await push(cliente)).deliversWork).toBe(false);
    // Cliente com um serviço, ou que aparece como freelancer numa contratação (uma troca faz isso),
    // também entrega trabalho. As linhas são deste teste.
    const categorias = (await request(app).get('/api/categories').expect(200)).body as {
      id: number;
    }[];
    const servico = await request(app)
      .post('/api/services')
      .set(auth(freela.token))
      .send({
        categoryId: categorias[0]!.id,
        title: `Serviço do ADR 56 ${seq++}`,
        description: 'Serviço usado para testar quem entrega trabalho',
        priceType: 'fixed',
        price: 80,
      })
      .expect(201);
    const comServico = await actor('client');
    await pool.query('UPDATE services SET user_id = :u WHERE id = :id', {
      u: comServico.id,
      id: servico.body.id,
    });
    expect((await push(comServico)).deliversWork).toBe(true);
    const contratante = await actor('client');
    const trocaDoLadoDeLa = await actor('client');
    await fundWallet(app, contratante.token, 100);
    const contrato = await contractFor(contratante, freela);
    await pool.query('UPDATE contracts SET freelancer_id = :u WHERE id = :id', {
      u: trocaDoLadoDeLa.id,
      id: contrato,
    });
    expect((await push(trocaDoLadoDeLa)).deliversWork).toBe(true);
  });

  it('prazo estourado de madrugada, pelo job real: sai na hora só para quem entrega e marcou', async () => {
    const cliente = await silenced(await actor('client'), ['deadline']);
    const marcou = await silenced(await actor('freelancer'), ['deadline']);
    const daVersaoAnterior = await silenced(await actor('freelancer')); // NULL: nada sai
    await fundWallet(app, cliente.token, 200);
    const a = await contractFor(cliente, marcou);
    const b = await contractFor(cliente, daVersaoAnterior);
    await pool.query(
      `UPDATE contracts SET deadline_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id IN (:a, :b)`,
      { a, b },
    );
    const run = await runOverdueContracts();
    expect(run.notified).toEqual(expect.arrayContaining([a, b]));

    // Quem entrega e marcou: sai na hora, prioridade alta, 12 h, etiqueta própria, sem marca.
    const saiu = await latest(marcou.id, 'contract_overdue', a);
    expect(await held(saiu)).toBe(false);
    expect(saiu.title).toMatch(/^Prazo estourado: /);
    expect(saiu.body).toMatch(
      /^Até \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}: entregue ou peça a extensão/,
    );
    const [target, payload, opts] = callsTo(marcou.endpoint).at(-1)!;
    expect(target).toBeTruthy();
    expect(opts).toStrictEqual({ ttlSeconds: 12 * 3600, urgency: 'high' });
    expect((payload as PushPayload).tag).toBe(`contract_overdue:${a}:n${saiu.id}`);
    const status = await request(app).get('/api/notifications/push').set(auth(marcou.token));
    // Retida no cartão fica só a proposta que chegou durante o silêncio; o prazo não entra.
    expect(status.body.held).toBe(1);

    // O cliente marcou também, mas a cópia dele não pede ação: fica retida.
    expect(await held(await latest(cliente.id, 'contract_overdue', a))).toBe(true);
    // A conta da versão anterior (nunca escolheu) continua em silêncio absoluto.
    expect(await held(await latest(daVersaoAnterior.id, 'contract_overdue', b))).toBe(true);
    expect(callsTo(daVersaoAnterior.endpoint)).toHaveLength(0);
  });

  it('o que saiu não entra no resumo: a marca é o maior retido e os de prazo vêm primeiro', async () => {
    const marcou = await silenced(await actor('freelancer'), ['deadline']);
    const aviso = (type: string, title: string, opts = {}) =>
      notificationsService.notify(
        marcou.id,
        { type, title, data: { contractId: 900_000 + seq++ } },
        opts,
      );
    await aviso('contract_proposal', 'Nova proposta A');
    const pA = await latest(marcou.id, 'contract_proposal');
    expect(await held(pA)).toBe(true);
    await aviso('contract_overdue', 'Prazo estourado: Logo', { passCategory: 'deadline' });
    expect(await held(await latest(marcou.id, 'contract_overdue'))).toBe(false);
    await aviso('contract_proposal', 'Nova proposta C');
    const pC = await latest(marcou.id, 'contract_proposal');
    expect(pC.id).toBeGreaterThan(pA.id);
    expect(await held(pC)).toBe(true);

    const depois = new Date(Date.now() + 3 * 3_600_000); // fora da janela h-1 → h+2
    spy.mockClear();
    const r = await runQuietPushSummary(depois);
    expect(r.sent).toContain(marcou.id);
    const [, resumo, opts] = callsTo(marcou.endpoint).at(-1)!;
    expect((resumo as PushPayload).body).toBe(
      '2 avisos ficaram por ver: Nova proposta A · Nova proposta C',
    );
    expect(Object.keys(opts as PushSendOptions)).toEqual(['ttlSeconds']);
    const [[user]] = (await pool.query(
      'SELECT push_quiet_summary_id AS mark FROM users WHERE id = :id',
      { id: marcou.id },
    )) as unknown as [[{ mark: number }]];
    expect(Number(user.mark)).toBe(pC.id);

    // Quem desmarcou: o prazo fica retido, e vem primeiro no resumo.
    const desmarcou = await silenced(await actor('freelancer'), []);
    await notificationsService.notify(desmarcou.id, {
      type: 'contract_proposal',
      title: 'Nova proposta',
    });
    expect(await held(await latest(desmarcou.id, 'contract_proposal'))).toBe(true);
    await notificationsService.notify(
      desmarcou.id,
      { type: 'contract_overdue', title: 'Prazo estourado: Vídeo' },
      { passCategory: 'deadline' },
    );
    expect(await held(await latest(desmarcou.id, 'contract_overdue'))).toBe(true);
    spy.mockClear();
    await runQuietPushSummary(depois);
    expect((callsTo(desmarcou.endpoint).at(-1)![1] as PushPayload).body).toBe(
      '2 avisos ficaram por ver: Prazo estourado: Vídeo · Nova proposta',
    );
  });

  it('extensão recusada: sai só com a carência correndo e tempo para agir; sem aviso ainda, um toque só', async () => {
    const cliente = await actor('client');
    const freela = await silenced(await actor('freelancer'), ['deadline']);
    await fundWallet(app, cliente.token, 400);
    const pede = (id: number) =>
      request(app)
        .post(`/api/contracts/${id}/extension`)
        .set(auth(freela.token))
        .send({
          deadlineAt: iso(12 * DAY),
          reason: 'O material do cliente chegou depois do combinado',
        })
        .expect(200);
    const recusa = (id: number) =>
      request(app)
        .post(`/api/contracts/${id}/extension/decline`)
        .set(auth(cliente.token))
        .expect(200);

    // Prazo no futuro: a recusa é o aviso de sempre e espera o silêncio.
    const x = await contractFor(cliente, freela);
    await pede(x);
    await recusa(x);
    const nx = await latest(freela.id, 'deadline_extension_declined', x);
    expect(nx.title).toBe('Extensão de prazo recusada');
    expect(await held(nx)).toBe(true);

    // Prazo vencido, aviso de atraso há 23 h: sobra 1 h, sai na hora com a hora-limite.
    const y = await contractFor(cliente, freela);
    await pede(y);
    await pool.query(
      `UPDATE contracts SET deadline_at = DATE_SUB(NOW(), INTERVAL 30 HOUR),
              overdue_notified_at = DATE_SUB(NOW(), INTERVAL 23 HOUR) WHERE id = :id`,
      { id: y },
    );
    await recusa(y);
    const ny = await latest(freela.id, 'deadline_extension_declined', y);
    expect(ny.title).toMatch(/^Extensão recusada: /);
    expect(ny.body).toMatch(/^Prazo vencido\. Até /);
    expect(await held(ny)).toBe(false);
    expect(callsTo(freela.endpoint).at(-1)![2]).toStrictEqual({
      ttlSeconds: 12 * 3600,
      urgency: 'high',
    });

    // Aviso há 23 h 50 min: acordar não muda o desfecho a tempo; avisa sem acordar.
    const z = await contractFor(cliente, freela);
    await pede(z);
    await pool.query(
      `UPDATE contracts SET deadline_at = DATE_SUB(NOW(), INTERVAL 30 HOUR),
              overdue_notified_at = DATE_SUB(NOW(), INTERVAL 1430 MINUTE) WHERE id = :id`,
      { id: z },
    );
    await recusa(z);
    const nz = await latest(freela.id, 'deadline_extension_declined', z);
    expect(nz.body).toContain('a carência acaba em minutos');
    expect(await held(nz)).toBe(true);

    // Prazo vencido com o pedido pendente e sem aviso ainda: a recusa espera; o aviso de atraso da
    // rodada seguinte é que sai — um toque só.
    const w = await contractFor(cliente, freela);
    await pede(w);
    await pool.query(
      `UPDATE contracts SET deadline_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id = :id`,
      {
        id: w,
      },
    );
    await recusa(w);
    expect(await held(await latest(freela.id, 'deadline_extension_declined', w))).toBe(true);
    expect((await runOverdueContracts()).notified).toContain(w);
    expect(await held(await latest(freela.id, 'contract_overdue', w))).toBe(false);
  });

  it('revisão com o prazo vencido: sai com a carência correndo; sem aviso ainda, quem sai é o aviso de atraso', async () => {
    const cliente = await actor('client');
    const freela = await silenced(await actor('freelancer'), ['deadline']);
    await fundWallet(app, cliente.token, 200);
    const entrega = (id: number) =>
      request(app)
        .post(`/api/contracts/${id}/deliver`)
        .set(auth(freela.token))
        .send({ message: 'Logo entregue em todas as versões' })
        .expect(200);
    const revisao = (id: number) =>
      request(app)
        .post(`/api/contracts/${id}/request-revision`)
        .set(auth(cliente.token))
        .send({ note: 'Falta a versão em fundo escuro' })
        .expect(200);

    // Entrega atrasada dentro da carência, revisão com 4 h de carência: sai com a hora-limite.
    const r1 = await contractFor(cliente, freela);
    await pool.query(
      `UPDATE contracts SET deadline_at = DATE_SUB(NOW(), INTERVAL 30 HOUR),
              overdue_notified_at = DATE_SUB(NOW(), INTERVAL 20 HOUR) WHERE id = :id`,
      { id: r1 },
    );
    await entrega(r1);
    await revisao(r1);
    const n1 = await latest(freela.id, 'contract_revision', r1);
    expect(n1.title).toMatch(/^Revisão pedida: /);
    expect(await held(n1)).toBe(false);

    // Entrega antes do prazo e revisão depois dele, sem aviso de atraso: a revisão espera, e o
    // aviso de atraso da rodada seguinte sai.
    const r2 = await contractFor(cliente, freela);
    await entrega(r2);
    await pool.query(
      `UPDATE contracts SET deadline_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id = :id`,
      {
        id: r2,
      },
    );
    await revisao(r2);
    const n2 = await latest(freela.id, 'contract_revision', r2);
    expect(n2.title).toBe('Revisão solicitada');
    expect(await held(n2)).toBe(true);
    expect((await runOverdueContracts()).notified).toContain(r2);
    expect(await held(await latest(freela.id, 'contract_overdue', r2))).toBe(false);
  });

  it.todo(
    'revisão depois de entrega atrasada com a carência esgotada não deveria abrir disputa sem chance de reação (próximo ADR, prazos)',
  );
});
