import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { moderationHealthService } from '../../src/modules/reports/moderation.health';
import { fundWallet } from './wallet.helpers';

/**
 * Saúde da moderação (ADR 47) contra o MySQL real: duas mensagens sinalizadas, uma dispensada e
 * uma removida, a remoção contestada e revertida. O painel conta a fila, o tempo até decidir, o
 * acerto por sinal e as contestações; só admin lê, e o período é validado. A série sai em CSV em dias
 * inteiros e a fila diz quantas passaram da meta (ADR 55).
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function actor(role: 'client' | 'freelancer', domain = 'escambo.test'): Promise<Actor> {
  const email = `int_saude_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

interface Health {
  windowDays: number;
  queue: {
    pending: number;
    automaticPending: number;
    appealsPending: number;
    accountReviewsOpen: number;
    overSlaPending: number;
  };
  decisions: { total: number; dismissed: number; actioned: number; medianHours: number | null };
  automatic: {
    flagged: number;
    dismissed: number;
    actioned: number;
    precision: number | null;
    signals: { signal: string; flagged: number; actioned: number; dismissed: number }[];
  };
  appeals: { decided: number; overturned: number; overturnRate: number | null };
  removals: { total: number; byType: { targetType: string; count: number }[] };
  slaHours: number;
  history: {
    day: string;
    received: number;
    actioned: number;
    dismissed: number;
    flagged: number;
    medianHours: number | null;
  }[];
  dailyReport: { enabled: boolean; hour: number; mailProvider: string; last: unknown };
}

afterAll(async () => {
  await pool.end();
});

describe('Saúde da moderação (ADR 47)', () => {
  it('conta fila, decisões, acerto por sinal e contestações; só admin; período validado', async () => {
    const client = await actor('client');
    const freelancer = await actor('freelancer');
    const admin = await actor('client', 'admin.escambo.test');
    await fundWallet(app, client.token, 200);
    const contract = await request(app).post('/api/contracts').set(auth(client.token)).send({
      freelancerId: freelancer.id,
      title: 'Fachada da loja',
      description: 'Contratação do teste de saúde da moderação',
      price: 80,
    });
    expect(contract.status, JSON.stringify(contract.body)).toBe(201);
    const send = async (content: string): Promise<number> => {
      const res = await request(app)
        .post(`/api/messaging/contracts/${contract.body.id}`)
        .set(auth(freelancer.token))
        .send({ content });
      expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
      return res.body.id as number;
    };
    const health = (token: string, query = 'days=30') =>
      request(app).get(`/api/admin/moderation/health?${query}`).set(auth(token));

    const before = (await health(admin.token).expect(200)).body as Health;
    // As colunas DATETIME guardam segundos inteiros: o corte fica alinhado ao segundo, senão uma
    // decisão gravada no mesmo segundo, depois dele, seria guardada como anterior.
    const cutoff = new Date(Math.floor(Date.now() / 1000) * 1000);
    expect(before.windowDays).toBe(30);

    // Duas sinalizações automáticas: uma dispensada (só telefone), uma removida (pix e telefone).
    const harmless = await send('Meu telefone para a entrega: (47) 3333-1234');
    const scam = await send('Me paga no pix por fora: (47) 99999-0001');
    const groups = (
      await request(app).get('/api/admin/reports?status=pending').set(auth(admin.token)).expect(200)
    ).body as { id: number; targetType: string; targetId: number }[];
    const groupOf = (id: number) =>
      groups.find((g) => g.targetType === 'message' && g.targetId === id)!.id;
    const mid = (await health(admin.token).expect(200)).body as Health;
    expect(mid.queue.pending).toBeGreaterThanOrEqual(before.queue.pending + 2);
    expect(mid.queue.automaticPending).toBeGreaterThanOrEqual(before.queue.automaticPending + 2);

    await request(app)
      .post(`/api/admin/reports/${groupOf(harmless)}/dismiss`)
      .set(auth(admin.token))
      .send({ note: 'Telefone para a entrega.' })
      .expect(200);
    const removed = await request(app)
      .post(`/api/admin/reports/${groupOf(scam)}/remove-content`)
      .set(auth(admin.token))
      .send({ note: 'Pagamento por fora.' })
      .expect(200);
    await request(app)
      .post(`/api/moderation/removals/${removed.body.removalId}/appeal`)
      .set(auth(freelancer.token))
      .send({ text: 'Era o pix da nota fiscal, combinado pelo Escambo.' })
      .expect(200);
    const appealed = (await health(admin.token).expect(200)).body as Health;
    expect(appealed.queue.appealsPending).toBeGreaterThanOrEqual(1);
    await request(app)
      .post(`/api/admin/appeals/${removed.body.removalId}/overturn`)
      .set(auth(admin.token))
      .send({ note: 'Contexto esclarecido.' })
      .expect(200);

    const after = (await health(admin.token).expect(200)).body as Health;
    expect(after.decisions.total).toBeGreaterThanOrEqual(before.decisions.total + 2);
    expect(after.decisions.dismissed).toBeGreaterThanOrEqual(before.decisions.dismissed + 1);
    expect(after.decisions.actioned).toBeGreaterThanOrEqual(before.decisions.actioned + 1);
    expect(after.decisions.medianHours).toEqual(expect.any(Number));
    expect(after.automatic.flagged).toBeGreaterThanOrEqual(before.automatic.flagged + 2);
    expect(after.automatic.dismissed).toBeGreaterThanOrEqual(before.automatic.dismissed + 1);
    expect(after.automatic.actioned).toBeGreaterThanOrEqual(before.automatic.actioned + 1);
    expect(after.automatic.precision).toBeGreaterThan(0);
    expect(after.automatic.precision).toBeLessThanOrEqual(1);
    const pix = after.automatic.signals.find((s) => s.signal === 'pix')!;
    const phone = after.automatic.signals.find((s) => s.signal === 'phone')!;
    expect(pix.actioned).toBeGreaterThanOrEqual(1);
    expect(phone.flagged).toBeGreaterThanOrEqual(2);
    expect(phone.dismissed).toBeGreaterThanOrEqual(1);
    expect(after.appeals.decided).toBeGreaterThanOrEqual(before.appeals.decided + 1);
    expect(after.appeals.overturned).toBeGreaterThanOrEqual(before.appeals.overturned + 1);
    expect(after.appeals.overturnRate).toBeGreaterThan(0);
    expect(after.removals.total).toBeGreaterThanOrEqual(before.removals.total + 1);
    expect(
      after.removals.byType.find((t) => t.targetType === 'message')!.count,
    ).toBeGreaterThanOrEqual(1);

    // Série por dia (ADR 50): contínua, no dia de Brasília, com as decisões de agora na ponta
    // (nos dois últimos dias, para não depender de rodar longe da meia-noite).
    expect(after.slaHours).toBe(24);
    expect(after.history.length).toBeGreaterThanOrEqual(30);
    expect(after.history.length).toBeLessThanOrEqual(32);
    expect(after.history.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))).toBe(true);
    const recent = after.history.slice(-2);
    expect(recent.reduce((sum, d) => sum + d.actioned, 0)).toBeGreaterThanOrEqual(1);
    expect(recent.reduce((sum, d) => sum + d.dismissed, 0)).toBeGreaterThanOrEqual(1);
    expect(recent.reduce((sum, d) => sum + d.flagged, 0)).toBeGreaterThanOrEqual(2);
    expect(recent.reduce((sum, d) => sum + d.received, 0)).toBeGreaterThanOrEqual(2);
    expect(recent.some((d) => d.medianHours !== null)).toBe(true);
    expect(after.history.reduce((sum, d) => sum + d.actioned + d.dismissed, 0)).toBe(
      after.decisions.total,
    );

    // O período fecha no instante do relatório (v1.32.1): com o relógio de antes das decisões,
    // nada do que foi gravado depois entra no total nem na série, e os dois continuam batendo.
    const past = await moderationHealthService.report(30, cutoff);
    expect(past.decisions.total).toBe(before.decisions.total);
    expect(past.automatic.flagged).toBe(before.automatic.flagged);
    expect(past.history.reduce((sum, d) => sum + d.actioned + d.dismissed, 0)).toBe(
      past.decisions.total,
    );
    expect(past.history.reduce((sum, d) => sum + d.flagged, 0)).toBe(past.automatic.flagged);

    // Quantas passaram da meta agora (ADR 55): uma sinalização esperando há três dias conta com a
    // meta em 24 h e em 48 h, e sai da conta com a meta em 100 h. Revisões de conta não contam.
    const stale = await send('Pix por fora de novo: (47) 99999-0003');
    await pool.query(
      `UPDATE content_reports SET created_at = DATE_SUB(NOW(), INTERVAL 72 HOUR)
        WHERE target_type = 'message' AND target_id = :id`,
      { id: stale },
    );
    const at24 = (await health(admin.token).expect(200)).body as Health;
    expect(at24.queue.overSlaPending).toBeGreaterThanOrEqual(1);
    expect(at24.queue.overSlaPending).toBeLessThanOrEqual(at24.queue.pending);
    expect(at24.dailyReport).toMatchObject({ enabled: true, mailProvider: 'simulated' });
    expect(at24.dailyReport.hour).toBeGreaterThanOrEqual(0);
    // Uma conta em revisão por reincidência (ADR 41) há três dias fica aberta de propósito: entra
    // em "contas em revisão", não em "passou da meta".
    const [review] = await pool.query<import('mysql2').ResultSetHeader>(
      `INSERT INTO content_reports (reporter_id, target_type, target_id, reason, description, status, created_at)
       VALUES (NULL, 'user', :id, 'other', 'Reincidência: terceira remoção', 'pending', DATE_SUB(NOW(), INTERVAL 72 HOUR))`,
      { id: freelancer.id },
    );
    const withReview = (await health(admin.token).expect(200)).body as Health;
    expect(withReview.queue.overSlaPending).toBe(at24.queue.overSlaPending);
    expect(withReview.queue.accountReviewsOpen).toBe(at24.queue.accountReviewsOpen + 1);
    await pool.query(`DELETE FROM content_reports WHERE id = :id`, { id: review.insertId });
    // Denúncia humana contra um perfil, sem descrição (opcional no formulário), esperando há três
    // dias: é denúncia de conteúdo e passou da meta — descrição nula não a transforma em revisão.
    const [human] = await pool.query<import('mysql2').ResultSetHeader>(
      `INSERT INTO content_reports (reporter_id, target_type, target_id, reason, description, status, created_at)
       VALUES (:reporter, 'user', :id, 'spam', NULL, 'pending', DATE_SUB(NOW(), INTERVAL 72 HOUR))`,
      { reporter: client.id, id: freelancer.id },
    );
    const withHuman = (await health(admin.token).expect(200)).body as Health;
    expect(withHuman.queue.overSlaPending).toBe(at24.queue.overSlaPending + 1);
    expect(withHuman.queue.accountReviewsOpen).toBe(at24.queue.accountReviewsOpen);
    await pool.query(`DELETE FROM content_reports WHERE id = :id`, { id: human.insertId });

    // A meta é parâmetro da plataforma: mudou, o painel devolve o novo valor na hora.
    const setSla = (value: number) =>
      request(app)
        .put('/api/admin/settings/moderation_sla_hours')
        .set(auth(admin.token))
        .send({ value })
        .expect(200);
    await setSla(48);
    const at48 = (await health(admin.token).expect(200)).body as Health;
    expect(at48.slaHours).toBe(48);
    expect(at48.queue.overSlaPending).toBeGreaterThanOrEqual(1);
    await setSla(100);
    const at100 = (await health(admin.token).expect(200)).body as Health;
    expect(at100.queue.overSlaPending).toBeLessThan(at48.queue.overSlaPending);
    await setSla(24);

    // CSV da série (ADR 55): 7 dias inteiros de Brasília mais hoje, nome pelas pontas, a linha de
    // hoje com o que entrou agora; a exportação fica nas ações do admin; só admin; período validado.
    const csv = await request(app)
      .get('/api/admin/moderation/health/export.csv?days=7')
      .set(auth(admin.token))
      .expect(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(
      /^attachment; filename="escambo-moderacao-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = (csv.text as string).split('\r\n');
    expect(lines[0]).toBe(
      '\uFEFFdia;denuncias_recebidas;sinalizacoes_automaticas;decididas_com_acao;dispensadas;decididas_total;mediana_horas;meta_horas;acima_da_meta',
    );
    expect(lines).toHaveLength(10);
    const today = lines[8]!.split(';');
    expect(today[0]).toBe(after.history[after.history.length - 1]!.day);
    expect(Number(today[1])).toBeGreaterThanOrEqual(2);
    expect(Number(today[2])).toBeGreaterThanOrEqual(2);
    expect(today[7]).toBe('24');
    const [[exported]] = await pool.query<import('mysql2').RowDataPacket[]>(
      `SELECT description FROM admin_actions
        WHERE admin_id = :id AND action = 'moderation_health_exported' ORDER BY id DESC LIMIT 1`,
      { id: admin.id },
    );
    expect(exported?.description).toMatch(/^7 dias · \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}$/);
    await request(app)
      .get('/api/admin/moderation/health/export.csv?days=7')
      .set(auth(client.token))
      .expect(403);
    await request(app)
      .get('/api/admin/moderation/health/export.csv?days=0')
      .set(auth(admin.token))
      .expect(422);

    // O período muda a janela; fora de 1 a 365 é 422; quem não é admin toma 403.
    expect(((await health(admin.token, 'days=7').expect(200)).body as Health).windowDays).toBe(7);
    await health(admin.token, 'days=0').expect(422);
    await health(admin.token, 'days=400').expect(422);
    await health(client.token).expect(403);
  });
});
