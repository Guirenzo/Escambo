import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { waitForNotification } from './notifications.helpers';
import { fundWallet } from './wallet.helpers';

/**
 * Anexos no chat (ADR 29), contra o MySQL e o disco de verdade: upload multipart, tipo pelo
 * conteúdo, histórico, download só pelas partes, nome de download limpo e limites.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 3),
]);
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);

/** Parser binário do supertest (PDF/ZIP não têm parser padrão). */
const binary = (
  res: NodeJS.ReadableStream,
  cb: (err: Error | null, body: Buffer) => void,
): void => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer | string) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

let seq = 0;
async function registerAndLogin(
  role: 'client' | 'freelancer',
): Promise<{ id: number; token: string }> {
  const email = `att_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app).post('/api/auth/register').send({ email, password, role }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

async function makeContract(): Promise<{
  client: { id: number; token: string };
  freelancer: { id: number; token: string };
  contractId: number;
}> {
  const client = await registerAndLogin('client');
  const freelancer = await registerAndLogin('freelancer');
  await fundWallet(app, client.token, 400);
  const created = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: 'Projeto com anexos',
      description: 'Contrato usado para exercitar imagens e arquivos no chat',
      price: 400,
    })
    .expect(201);
  return { client, freelancer, contractId: created.body.id };
}

const upload = (contractId: number, token: string) =>
  request(app).post(`/api/messaging/contracts/${contractId}/attachments`).set(auth(token));

afterAll(async () => {
  await pool.end();
});

describe('Anexos no chat (ADR 29)', () => {
  it('imagem com legenda: 201 tipado, no histórico, baixada inline pela outra parte, que é notificada', async () => {
    const { client, freelancer, contractId } = await makeContract();

    const sent = await upload(contractId, client.token)
      .field('content', 'olha o rascunho')
      .attach('file', PNG, { filename: 'rascunho.png', contentType: 'image/png' });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      senderId: client.id,
      type: 'image',
      content: 'olha o rascunho',
      attachment: {
        name: 'rascunho.png',
        mime: 'image/png',
        size: PNG.length,
        url: `/api/messaging/attachments/${sent.body.id}`,
      },
    });

    const history = await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token))
      .expect(200);
    expect(history.body.messages).toHaveLength(1);
    expect(history.body.messages[0]).toMatchObject({ id: sent.body.id, type: 'image' });

    const dl = await request(app)
      .get(sent.body.attachment.url)
      .set(auth(freelancer.token))
      .buffer(true)
      .parse(binary);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('image/png');
    expect(dl.headers['content-disposition']).toBe(
      `inline; filename="rascunho.png"; filename*=UTF-8''rascunho.png`,
    );
    expect(dl.headers['cache-control']).toBe('private, max-age=3600');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(dl.body as Buffer, PNG)).toBe(0);

    expect(await waitForNotification(app, freelancer.token, 'chat_message')).toBe(true);
  });

  it('PDF sem legenda vira download com o nome limpo; docx é ZIP por dentro e mantém o nome', async () => {
    const { client, freelancer, contractId } = await makeContract();

    const pdf = await upload(contractId, freelancer.token).attach('file', PDF, {
      filename: '../../briefing "final".pdf',
      contentType: 'application/octet-stream', // o declarado é ignorado
    });
    expect(pdf.status).toBe(201);
    expect(pdf.body).toMatchObject({
      type: 'file',
      content: '',
      attachment: { name: 'briefing final.pdf', mime: 'application/pdf', size: PDF.length },
    });

    const dl = await request(app)
      .get(pdf.body.attachment.url)
      .set(auth(client.token))
      .buffer(true)
      .parse(binary);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toContain(
      'attachment; filename="briefing final.pdf"',
    );
    expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);

    const docx = await upload(contractId, client.token).attach('file', ZIP, {
      filename: 'proposta.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(docx.status).toBe(201);
    expect(docx.body.attachment).toMatchObject({ name: 'proposta.docx', mime: 'application/zip' });
  });

  it('o tipo vem do conteúdo: HTML disfarçado, SVG, vazio ou sem arquivo → 422', async () => {
    const { client, contractId } = await makeContract();

    const html = await upload(contractId, client.token).attach(
      'file',
      Buffer.from('<html><script>alert(1)</script></html>'),
      { filename: 'foto.png', contentType: 'image/png' },
    );
    expect(html.status).toBe(422);
    expect(html.body.error).toBe('unsupported_file_type');

    const svg = await upload(contractId, client.token).attach(
      'file',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
      { filename: 'logo.svg', contentType: 'image/svg+xml' },
    );
    expect(svg.status).toBe(422);

    const empty = await upload(contractId, client.token).attach('file', Buffer.alloc(0), {
      filename: 'vazio.png',
      contentType: 'image/png',
    });
    expect(empty.status).toBe(422);
    expect(empty.body.error).toBe('empty_file');

    const none = await upload(contractId, client.token).send({ content: 'sem arquivo' });
    expect(none.status).toBe(422);
    expect(none.body.error).toBe('file_required');

    const history = await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token))
      .expect(200);
    expect(history.body.messages).toHaveLength(0);
  });

  it('arquivo acima de UPLOAD_MAX_MB → 413 file_too_large', async () => {
    const { client, contractId } = await makeContract();
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const res = await upload(contractId, client.token).attach('file', big, {
      filename: 'gigante.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('file_too_large');
  });

  it('só as partes: terceiro não envia (403) nem baixa (403); sem token 401; inexistente e texto 404', async () => {
    const { client, freelancer, contractId } = await makeContract();
    const stranger = await registerAndLogin('client');

    const denied = await upload(contractId, stranger.token).attach('file', PNG, {
      filename: 'x.png',
      contentType: 'image/png',
    });
    expect(denied.status).toBe(403);

    const sent = await upload(contractId, client.token).attach('file', PNG, {
      filename: 'x.png',
      contentType: 'image/png',
    });
    const url = sent.body.attachment.url as string;

    expect((await request(app).get(url).set(auth(stranger.token))).status).toBe(403);
    expect((await request(app).get(url)).status).toBe(401);
    expect(
      (await request(app).get('/api/messaging/attachments/999999999').set(auth(client.token)))
        .status,
    ).toBe(404);

    const text = await request(app)
      .post(`/api/messaging/contracts/${contractId}`)
      .set(auth(freelancer.token))
      .send({ content: 'só texto' })
      .expect(201);
    expect(text.body).toMatchObject({ type: 'text', attachment: null });
    const notFile = await request(app)
      .get(`/api/messaging/attachments/${text.body.id}`)
      .set(auth(client.token));
    expect(notFile.status).toBe(404);
  });
});
