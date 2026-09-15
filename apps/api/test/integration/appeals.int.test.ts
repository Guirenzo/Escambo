import sharp from 'sharp';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { appealsService } from '../../src/modules/reports/appeals.service';

/**
 * Contestação e reincidência na moderação de imagens (ADR 41) contra o MySQL e o disco reais:
 * remoção contestável com o arquivo em quarentena, contestação só do dono, uma vez e no prazo,
 * fila do admin com a imagem guardada, reversão que devolve a foto e tira do bloqueio, remoção
 * mantida que apaga o arquivo, expurgo depois do prazo, bloqueio de envio na segunda remoção e
 * revisão da conta na terceira.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const DAY_MS = 86_400_000;

interface Actor {
  id: number;
  ulid: string;
  token: string;
}

let seq = 0;
async function actor(role: 'client' | 'freelancer', domain = 'escambo.test'): Promise<Actor> {
  const email = `int_appeal_${role}_${Date.now()}_${seq++}@${domain}`;
  const password = 'senha-integracao-123';
  await request(app).post('/api/auth/register').send({ email, password, role }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  const a: Actor = {
    id: login.body.user.id,
    ulid: login.body.user.ulid,
    token: login.body.accessToken,
  };
  if (role === 'freelancer') {
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(a.token))
      .send({ fullName: 'Dona do Portfólio', city: 'Joinville' })
      .expect(200);
  }
  return a;
}

/** 9 × 8 blocos de tons diferentes: imagem com detalhe, que dá impressão perceptual estável. */
function blocks(seed: number, cell = 60): Promise<Buffer> {
  const values: number[] = [];
  let s = seed;
  for (let i = 0; i < 72; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    values.push(20 + (s % 216));
  }
  const width = 9 * cell;
  const height = 8 * cell;
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw[y * width + x] = values[Math.floor(y / cell) * 9 + Math.floor(x / cell)]!;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

const upload = (a: Actor, buf: Buffer, purpose: 'avatar' | 'portfolio') =>
  request(app)
    .post('/api/media')
    .set(auth(a.token))
    .field('purpose', purpose)
    .attach('file', buf, { filename: 'imagem.png', contentType: 'image/png' });
const report = (a: Actor, body: Record<string, unknown>) =>
  request(app).post('/api/reports').set(auth(a.token)).send(body);
const act = (a: Actor, id: number, action: string, note?: string) =>
  request(app).post(`/api/admin/reports/${id}/${action}`).set(auth(a.token)).send({ note });
const appeal = (a: Actor, id: number, text: string) =>
  request(app).post(`/api/moderation/removals/${id}/appeal`).set(auth(a.token)).send({ text });
const decide = (a: Actor, id: number, decision: 'uphold' | 'overturn', note?: string) =>
  request(app).post(`/api/admin/appeals/${id}/${decision}`).set(auth(a.token)).send({ note });
const removalsOf = (a: Actor) => request(app).get('/api/moderation/removals').set(auth(a.token));
const appealsQueue = (a: Actor, status = 'pending') =>
  request(app).get(`/api/admin/appeals?status=${status}`).set(auth(a.token));

interface Removal {
  id: number;
  status: string;
  canAppeal: boolean;
  [k: string]: unknown;
}
interface Appeal {
  id: number;
  status: string;
  hasImage: boolean;
  [k: string]: unknown;
}
interface Removed {
  fileRemoved: boolean;
  blocked: boolean;
  removalId: number;
  ownerStrikes: number;
  uploadsBlockedUntil: string | null;
  accountReviewOpened: boolean;
}
interface Note {
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
}

async function notificationsOf(a: Actor): Promise<Note[]> {
  const res = await request(app).get('/api/notifications').set(auth(a.token)).expect(200);
  return res.body.items as Note[];
}

/** Trabalho do portfólio com imagem enviada ao Escambo. */
async function addWork(owner: Actor, title: string, seed: number): Promise<{ id: number }> {
  const sent = await upload(owner, await blocks(seed), 'portfolio');
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  const res = await request(app)
    .post('/api/profiles/portfolio')
    .set(auth(owner.token))
    .send({ title, imageUrl: sent.body.url })
    .expect(201);
  return (res.body as { id: number; title: string }[]).find((i) => i.title === title)!;
}

/** Denúncia de imagem e remoção pelo admin, como na fila. */
async function removeImage(
  reporter: Actor,
  admin: Actor,
  targetType: 'avatar' | 'portfolio_item',
  targetId: number,
  note?: string,
): Promise<Removed> {
  const rep = await report(reporter, { targetType, targetId, reason: 'offensive' });
  expect(rep.status, JSON.stringify(rep.body)).toBe(201);
  const done = await act(admin, rep.body.id, 'remove-image', note);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return done.body as Removed;
}

afterAll(async () => {
  await pool.end();
});

describe('Contestação e reincidência (ADR 41)', () => {
  it('o dono contesta a foto removida e o admin reverte: a foto volta, sai do bloqueio e deixa de contar', async () => {
    const image = await blocks(1101);
    const owner = await actor('freelancer');
    const sent = await upload(owner, image, 'avatar');
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const url = sent.body.url as string;
    await request(app)
      .put('/api/profiles/freelancer')
      .set(auth(owner.token))
      .send({ fullName: 'Dona do Portfólio', city: 'Joinville', avatarUrl: url })
      .expect(200);
    const client = await actor('client');
    const admin = await actor('client', 'admin.escambo.test');

    const removed = await removeImage(client, admin, 'avatar', owner.id, 'Parece ofensiva.');
    expect(removed).toMatchObject({
      fileRemoved: true,
      blocked: true,
      removalId: expect.any(Number),
      ownerStrikes: 1,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });
    const id = removed.removalId;
    await request(app).get(url).expect(404);

    const warned = (await notificationsOf(owner)).find((n) => n.type === 'content_removed');
    expect(warned!.data).toMatchObject({ removalId: id });
    expect(warned!.body).toMatch(
      /Se discordar, conteste pelo seu perfil até \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}\./,
    );

    const mine = await removalsOf(owner).expect(200);
    expect(mine.body.strikes).toEqual({
      strikes: 1,
      imageStrikes: 1,
      windowDays: 180,
      reviewThreshold: 3,
      uploadsBlockedUntil: null,
    });
    expect(mine.body.removals).toHaveLength(1);
    const listed = mine.body.removals[0] as Removal & { removedAt: string; appealDeadline: string };
    expect(listed).toMatchObject({
      id,
      targetType: 'avatar',
      label: 'Foto de perfil',
      reason: 'offensive',
      note: 'Parece ofensiva.',
      status: 'removed',
      canAppeal: true,
      appealText: null,
    });
    expect(Date.parse(listed.appealDeadline) - Date.parse(listed.removedAt)).toBe(14 * DAY_MS);

    // Só o dono contesta, com um texto de verdade, e uma vez só.
    expect((await removalsOf(client).expect(200)).body.removals).toEqual([]);
    const foreign = await appeal(client, id, 'Quero contestar a remoção de outra pessoa.');
    expect([foreign.status, foreign.body.error]).toEqual([404, 'removal_not_found']);
    expect((await appeal(owner, id, 'curto')).status).toBe(422);
    const text = 'A foto é minha, tirada no meu escritório, e não mostra nada ofensivo.';
    const appealed = await appeal(owner, id, text);
    expect(appealed.status, JSON.stringify(appealed.body)).toBe(200);
    expect(appealed.body).toMatchObject({
      id,
      status: 'appealed',
      canAppeal: false,
      appealText: text,
    });
    const twice = await appeal(owner, id, 'Contestando mais uma vez a mesma remoção.');
    expect([twice.status, twice.body.error]).toEqual([409, 'appeal_exists']);

    // Fila do admin, com a imagem guardada visível só para admin.
    expect((await appealsQueue(client)).status).toBe(403);
    const pending = (await appealsQueue(admin).expect(200)).body as Appeal[];
    expect(pending.find((a) => a.id === id)).toMatchObject({
      owner: { id: owner.id, ulid: owner.ulid, name: 'Dona do Portfólio' },
      label: 'Foto de perfil',
      reason: 'offensive',
      note: 'Parece ofensiva.',
      appealText: text,
      status: 'appealed',
      decidedAt: null,
      hasImage: true,
      ownerStrikes: 1,
    });
    const img = await request(app).get(`/api/admin/appeals/${id}/image`).set(auth(admin.token));
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/webp');
    expect(img.headers['cache-control']).toBe('private, no-store');
    await request(app).get(`/api/admin/appeals/${id}/image`).set(auth(owner.token)).expect(403);

    const decided = await decide(admin, id, 'overturn', 'Foto legítima.');
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body).toEqual({
      status: 'overturned',
      restoredReferences: 1,
      imageRestored: true,
      contentRestored: true,
      fileDeleted: false,
    });

    const [profile] = await pool.query(
      'SELECT avatar_url FROM profiles_freelancer WHERE user_id = ?',
      [owner.id],
    );
    expect((profile as { avatar_url: string | null }[])[0]!.avatar_url).toBe(url);
    await request(app).get(url).expect(200);
    await request(app).get(`${url}?w=128`).expect(200);
    // Fora da lista de bloqueio: a mesma imagem pode ser enviada de novo.
    await upload(owner, image, 'avatar').expect(201);

    const after = await removalsOf(owner).expect(200);
    expect(after.body.strikes.strikes).toBe(0);
    expect(after.body.removals[0]).toMatchObject({
      status: 'overturned',
      decisionNote: 'Foto legítima.',
    });
    expect((await notificationsOf(owner)).find((n) => n.type === 'appeal_decided')).toMatchObject({
      title: 'Contestação aceita: sua imagem voltou',
      data: { removalId: id, decision: 'overturned' },
    });
    const again = await decide(admin, id, 'uphold');
    expect([again.status, again.body.error]).toEqual([409, 'appeal_not_pending']);
    const [actions] = await pool.query(
      'SELECT action, description FROM admin_actions WHERE target_type = ? AND target_id = ?',
      ['image_removal', id],
    );
    expect(actions).toEqual([{ action: 'appeal_overturned', description: 'Foto legítima.' }]);
  });

  it('remoção mantida apaga o arquivo e continua contando; a segunda bloqueia o envio; prazo vencido não contesta e o expurgo limpa', async () => {
    const owner = await actor('freelancer');
    const client = await actor('client');
    const admin = await actor('client', 'admin.escambo.test');
    const mural = await addWork(owner, 'Mural da escola', 1201);
    const facade = await addWork(owner, 'Fachada da loja', 1301);

    const first = await removeImage(client, admin, 'portfolio_item', mural.id);
    await appeal(
      owner,
      first.removalId,
      'O mural foi pintado por mim com autorização da escola.',
    ).expect(200);
    const upheld = await decide(admin, first.removalId, 'uphold', 'Continua fora das regras.');
    expect(upheld.status, JSON.stringify(upheld.body)).toBe(200);
    expect(upheld.body).toEqual({
      status: 'upheld',
      restoredReferences: 0,
      imageRestored: false,
      contentRestored: false,
      fileDeleted: true,
    });
    const gone = await request(app)
      .get(`/api/admin/appeals/${first.removalId}/image`)
      .set(auth(admin.token));
    expect([gone.status, gone.body.error]).toEqual([404, 'removal_image_not_found']);
    const decidedList = (await appealsQueue(admin, 'decided').expect(200)).body as Appeal[];
    expect(decidedList.find((a) => a.id === first.removalId)).toMatchObject({
      status: 'upheld',
      hasImage: false,
      decisionNote: 'Continua fora das regras.',
    });
    expect((await notificationsOf(owner)).find((n) => n.type === 'appeal_decided')).toMatchObject({
      title: 'Contestação analisada: a remoção foi mantida',
      body: 'Imagem do trabalho “Mural da escola” continua fora do ar. Continua fora das regras.',
    });

    // Mantida continua contando: a segunda remoção bloqueia o envio por 7 dias.
    const second = await removeImage(client, admin, 'portfolio_item', facade.id);
    expect(second).toMatchObject({ ownerStrikes: 2, accountReviewOpened: false });
    const until = Date.parse(second.uploadsBlockedUntil!);
    expect(until).toBeGreaterThan(Date.now() + 6.9 * DAY_MS);
    expect(until).toBeLessThan(Date.now() + 7.1 * DAY_MS);
    const blocked = await upload(owner, await blocks(1401), 'portfolio');
    expect([blocked.status, blocked.body.error]).toEqual([403, 'uploads_restricted']);
    const warned = (await notificationsOf(owner)).find(
      (n) => n.data?.removalId === second.removalId,
    );
    expect(warned!.body).toContain(
      'Como é a 2ª imagem removida nos últimos 180 dias, o envio de imagens fica bloqueado até',
    );

    // Prazo vencido: não contesta mais, e o expurgo apaga o arquivo guardado.
    await pool.query(
      'UPDATE content_removals SET removed_at = DATE_SUB(NOW(), INTERVAL 15 DAY) WHERE id = ?',
      [second.removalId],
    );
    const late = await appeal(owner, second.removalId, 'Contestação enviada depois do prazo.');
    expect([late.status, late.body.error]).toEqual([410, 'appeal_window_closed']);
    const listed = (await removalsOf(owner).expect(200)).body.removals as Removal[];
    expect(listed.find((r) => r.id === second.removalId)).toMatchObject({
      status: 'removed',
      canAppeal: false,
    });
    expect(await appealsService.purgeQuarantine()).toBeGreaterThanOrEqual(1);
    const [rows] = await pool.query('SELECT file_purged_at FROM content_removals WHERE id = ?', [
      second.removalId,
    ]);
    expect((rows as { file_purged_at: Date | null }[])[0]!.file_purged_at).not.toBeNull();
    const purged = await request(app)
      .get(`/api/admin/appeals/${second.removalId}/image`)
      .set(auth(admin.token));
    expect(purged.status).toBe(404);
  });

  it('na terceira remoção a conta vai para a fila de revisão, uma vez enquanto ela estiver aberta', async () => {
    const owner = await actor('freelancer');
    const client = await actor('client');
    const admin = await actor('client', 'admin.escambo.test');
    // Todas as imagens sobem antes: da segunda remoção em diante o envio fica bloqueado.
    const works: { id: number }[] = [];
    const seeds = [1501, 1601, 1701, 1801];
    for (let i = 0; i < seeds.length; i++) {
      works.push(await addWork(owner, `Trabalho ${i + 1}`, seeds[i]!));
    }

    const results: Removed[] = [];
    for (const w of works) results.push(await removeImage(client, admin, 'portfolio_item', w.id));
    expect(results.map((r) => [r.ownerStrikes, r.accountReviewOpened])).toEqual([
      [1, false],
      [2, false],
      [3, true],
      [4, false],
    ]);
    // O bloqueio cresce a cada remoção: 7 dias na segunda, 14 na terceira.
    expect(Date.parse(results[2]!.uploadsBlockedUntil!)).toBeGreaterThan(
      Date.now() + 13.9 * DAY_MS,
    );

    const pending = (
      await request(app).get('/api/admin/reports?status=pending').set(auth(admin.token)).expect(200)
    ).body as { targetType: string; targetId: number; [k: string]: unknown }[];
    const review = pending.filter((g) => g.targetType === 'user' && g.targetId === owner.id);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({
      label: 'Perfil',
      reports: 1,
      descriptions: ['Reincidência: 3 remoções de conteúdo nos últimos 180 dias. Revise a conta.'],
    });
  });
});
