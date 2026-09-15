import sharp from 'sharp';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';

/**
 * Moderação de imagens (ADR 39) contra o MySQL e o disco reais: denúncia de foto e de imagem do
 * portfólio com a imagem guardada, recusas, fila agrupada só para admin, remoção que limpa o
 * perfil, apaga o arquivo, avisa o dono e fica registrada, bloqueio do reenvio (inclusive
 * reencodado e reduzido), dispensa e resolução.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

interface Actor {
  id: number;
  ulid: string;
  token: string;
}

let seq = 0;
async function actor(role: 'client' | 'freelancer', domain = 'escambo.test'): Promise<Actor> {
  const email = `int_modimg_${role}_${Date.now()}_${seq++}@${domain}`;
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
      .send({ fullName: 'Dono da Foto', city: 'Joinville' })
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

async function setAvatar(owner: Actor, image: Buffer): Promise<string> {
  const res = await upload(owner, image, 'avatar');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await request(app)
    .put('/api/profiles/freelancer')
    .set(auth(owner.token))
    .send({ fullName: 'Dono da Foto', city: 'Joinville', avatarUrl: res.body.url })
    .expect(200);
  return res.body.url as string;
}

const report = (a: Actor, body: Record<string, unknown>) =>
  request(app).post('/api/reports').set(auth(a.token)).send(body);
const queue = (a: Actor, status = 'pending') =>
  request(app).get(`/api/admin/reports?status=${status}`).set(auth(a.token));
const act = (a: Actor, id: number, action: string, note?: string) =>
  request(app).post(`/api/admin/reports/${id}/${action}`).set(auth(a.token)).send({ note });

interface Group {
  id: number;
  targetType: string;
  targetId: number;
  [k: string]: unknown;
}
const findGroup = (list: Group[], type: string, id: number): Group | undefined =>
  list.find((g) => g.targetType === type && g.targetId === id);

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

afterAll(async () => {
  await pool.end();
});

describe('Moderação de imagens (ADR 39)', () => {
  it('denúncia de foto guarda a imagem e recusa repetida, a própria e alvo sem imagem; fila só para admin', async () => {
    const owner = await actor('freelancer');
    const url = await setAvatar(owner, await blocks(11));
    const c1 = await actor('client');
    const c2 = await actor('client');
    const admin = await actor('client', 'admin.escambo.test');

    const first = await report(c1, {
      targetType: 'avatar',
      targetId: owner.id,
      reason: 'offensive',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ targetType: 'avatar', imageUrl: url, status: 'pending' });

    const again = await report(c1, { targetType: 'avatar', targetId: owner.id, reason: 'spam' });
    expect([again.status, again.body.error]).toEqual([409, 'already_reported']);
    const own = await report(owner, { targetType: 'avatar', targetId: owner.id, reason: 'spam' });
    expect([own.status, own.body.error]).toEqual([422, 'cannot_report_own_content']);
    const noImage = await report(c1, { targetType: 'avatar', targetId: c2.id, reason: 'spam' });
    expect([noImage.status, noImage.body.error]).toEqual([422, 'report_target_without_image']);
    const missing = await report(c1, {
      targetType: 'portfolio_item',
      targetId: 99_999_999,
      reason: 'spam',
    });
    expect([missing.status, missing.body.error]).toEqual([404, 'report_target_not_found']);
    await report(c2, {
      targetType: 'avatar',
      targetId: owner.id,
      reason: 'fraud',
      description: 'foto de outra pessoa',
    }).expect(201);

    expect((await queue(c1)).status).toBe(403);
    const list = await queue(admin);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const group = findGroup(list.body as Group[], 'avatar', owner.id);
    expect(group).toMatchObject({
      label: 'Foto de perfil',
      imageUrl: url,
      imageLive: true,
      reports: 2,
      status: 'pending',
      owner: { id: owner.id, ulid: owner.ulid, name: 'Dono da Foto' },
      descriptions: ['foto de outra pessoa'],
    });
    expect(group!.reasons).toEqual(
      expect.arrayContaining([
        { reason: 'offensive', count: 1 },
        { reason: 'fraud', count: 1 },
      ]),
    );
  });

  it('remover a foto: some do perfil e do disco, dono avisado, ação registrada e a imagem não volta', async () => {
    const original = await blocks(21);
    const owner = await actor('freelancer');
    const url = await setAvatar(owner, original);
    await request(app).get(`${url}?w=128`).expect(200);
    const client = await actor('client');
    const admin = await actor('client', 'admin.escambo.test');
    const rep = await report(client, {
      targetType: 'avatar',
      targetId: owner.id,
      reason: 'offensive',
    }).expect(201);

    const done = await act(admin, rep.body.id, 'remove-image', 'Imagem ofensiva.');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({
      status: 'actioned',
      reports: 1,
      referencesCleared: 1,
      fileRemoved: true,
      blocked: true,
      removalId: expect.any(Number),
      ownerStrikes: 1,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });

    const [profile] = await pool.query(
      'SELECT avatar_url FROM profiles_freelancer WHERE user_id = ?',
      [owner.id],
    );
    expect((profile as { avatar_url: string | null }[])[0]!.avatar_url).toBeNull();
    await request(app).get(url).expect(404);
    await request(app).get(`${url}?w=128`).expect(404);

    const removed = (await notificationsOf(owner)).find((n) => n.type === 'content_removed');
    expect(removed).toMatchObject({
      title: 'Sua foto de perfil foi removida',
      data: { contentRemoved: 'avatar', reportId: rep.body.id },
    });
    expect(removed!.body).toContain('Imagem ofensiva.');

    const [actions] = await pool.query(
      'SELECT target_type, description FROM admin_actions WHERE action = ? AND target_id = ?',
      ['image_removed', owner.id],
    );
    expect(actions).toEqual([{ target_type: 'avatar', description: 'Imagem ofensiva.' }]);

    const resolved = await queue(admin, 'resolved').expect(200);
    expect(findGroup(resolved.body as Group[], 'avatar', owner.id)).toMatchObject({
      status: 'actioned',
      resolutionNote: 'Imagem ofensiva.',
      imageLive: false,
    });
    const twice = await act(admin, rep.body.id, 'dismiss');
    expect([twice.status, twice.body.error]).toEqual([409, 'report_already_resolved']);

    // Reenvio: o mesmo arquivo e a mesma imagem reencodada em JPEG e reduzida são recusados.
    const smaller = await sharp(original).resize(270, 240).jpeg({ quality: 50 }).toBuffer();
    for (const again of [original, smaller]) {
      const blocked = await upload(owner, again, 'avatar');
      expect([blocked.status, blocked.body.error]).toEqual([422, 'image_blocked']);
    }
    // Outra imagem, e uma lisa (sem detalhe para comparação perceptual), passam.
    await upload(owner, await blocks(987), 'avatar').expect(201);
    const flat = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#777' },
    })
      .png()
      .toBuffer();
    await upload(owner, flat, 'avatar').expect(201);
  });

  it('portfólio: remover tira só a imagem do trabalho; dispensar e resolver fecham sem mexer', async () => {
    const owner = await actor('freelancer');
    const client = await actor('client');
    const admin = await actor('client', 'admin.escambo.test');
    const logoImage = (await upload(owner, await blocks(31), 'portfolio').expect(201)).body
      .url as string;
    const menuImage = (await upload(owner, await blocks(41), 'portfolio').expect(201)).body
      .url as string;
    await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(owner.token))
      .send({ title: 'Logo da padaria', imageUrl: logoImage })
      .expect(201);
    const created = await request(app)
      .post('/api/profiles/portfolio')
      .set(auth(owner.token))
      .send({ title: 'Cardápio', imageUrl: menuImage })
      .expect(201);
    const items = created.body as { id: number; title: string; imageUrl: string | null }[];
    const logo = items.find((i) => i.title === 'Logo da padaria')!;
    const menu = items.find((i) => i.title === 'Cardápio')!;

    const r1 = await report(client, {
      targetType: 'portfolio_item',
      targetId: logo.id,
      reason: 'illegal',
    }).expect(201);
    const r2 = await report(client, {
      targetType: 'portfolio_item',
      targetId: menu.id,
      reason: 'spam',
    }).expect(201);
    const pending = (await queue(admin).expect(200)).body as Group[];
    expect(findGroup(pending, 'portfolio_item', logo.id)).toMatchObject({
      label: 'Imagem do trabalho “Logo da padaria”',
      imageUrl: logoImage,
      imageLive: true,
    });

    // Denúncia que não é de imagem não remove imagem; resolver fecha depois da ação em outro lugar.
    const userReport = await report(client, {
      targetType: 'user',
      targetId: owner.id,
      reason: 'off_platform',
    }).expect(201);
    const notImage = await act(admin, userReport.body.id, 'remove-image');
    expect([notImage.status, notImage.body.error]).toEqual([422, 'not_an_image_report']);
    const resolved = await act(admin, userReport.body.id, 'resolve', 'Conta suspensa.').expect(200);
    expect(resolved.body).toEqual({
      status: 'actioned',
      reports: 1,
      referencesCleared: 0,
      fileRemoved: false,
      blocked: false,
      removalId: null,
      ownerStrikes: null,
      uploadsBlockedUntil: null,
      accountReviewOpened: false,
    });

    const removed = await act(admin, r1.body.id, 'remove-image').expect(200);
    expect(removed.body).toMatchObject({ referencesCleared: 1, fileRemoved: true, blocked: true });
    const dismissed = await act(admin, r2.body.id, 'dismiss', 'Não é spam.').expect(200);
    expect(dismissed.body).toMatchObject({ status: 'dismissed', reports: 1, referencesCleared: 0 });

    const mine = (
      await request(app).get('/api/profiles/portfolio').set(auth(owner.token)).expect(200)
    ).body as { id: number; title: string; imageUrl: string | null }[];
    expect(mine.find((i) => i.id === logo.id)).toMatchObject({
      title: 'Logo da padaria',
      imageUrl: null,
    });
    expect(mine.find((i) => i.id === menu.id)!.imageUrl).toBe(menuImage);
    await request(app).get(menuImage).expect(200);
    await request(app).get(logoImage).expect(404);

    const note = (await notificationsOf(owner)).find(
      (n) => n.type === 'content_removed' && n.data?.reportId === r1.body.id,
    );
    expect(note).toMatchObject({
      title: 'A imagem do trabalho “Logo da padaria” foi removida',
      data: { contentRemoved: 'portfolio_item' },
    });
  });
});
