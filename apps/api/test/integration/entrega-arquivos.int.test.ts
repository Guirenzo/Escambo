import { stat } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2';
import request from 'supertest';
import type { ChatMessage, ContractWithHistory, DeliveryAttachment } from '@escambo/types';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runPurgeAttachments } from '../../src/jobs/purge-attachments';
import { attachmentPath, listUploadedFiles } from '../../src/modules/messaging/attachments.storage';
import { fundWallet } from './wallet.helpers';

/**
 * Entrega com arquivo (RF-035) contra o MySQL e o disco de verdade: a entrega única, a reentrega e
 * a entrega de um marco levam arquivos em multipart, que viram anexos do chat do par (ADR 29) —
 * mesmo tipo pelo conteúdo, mesmos limites, mesmo download só pelas partes, mesma retenção
 * (ADR 31) e mesma moderação (ADR 44).
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(300, 7),
]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
const MB = 1024 * 1024;

/** Parser binário do supertest (PDF/ZIP não têm parser padrão). */
const binary = (
  res: NodeJS.ReadableStream,
  cb: (err: Error | null, body: Buffer) => void,
): void => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer | string) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

interface Actor {
  id: number;
  token: string;
}

let seq = 0;
async function registerAndLogin(role: 'client' | 'freelancer', admin = false): Promise<Actor> {
  const email = admin
    ? `entrega_arq_admin_${Date.now()}_${seq++}@admin.escambo.test`
    : `entrega_arq_${role}_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ legalAccepted: true, email, password, role })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { id: login.body.user.id, token: login.body.accessToken };
}

/** Contratação aceita (entrega única ou por marcos), pronta para a entrega. */
async function acceptedContract(milestones?: { title: string; amount: number }[]): Promise<{
  client: Actor;
  freelancer: Actor;
  contractId: number;
}> {
  const client = await registerAndLogin('client');
  const freelancer = await registerAndLogin('freelancer');
  await fundWallet(app, client.token, 300);
  const created = await request(app)
    .post('/api/contracts')
    .set(auth(client.token))
    .send({
      freelancerId: freelancer.id,
      title: 'Identidade visual',
      description: 'Contratação para exercitar a entrega com arquivos',
      price: 300,
      ...(milestones ? { milestones } : {}),
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const contractId = created.body.id as number;
  await request(app)
    .post(`/api/contracts/${contractId}/accept`)
    .set(auth(freelancer.token))
    .expect(200);
  return { client, freelancer, contractId };
}

const deliverRequest = (contractId: number, token: string) =>
  request(app).post(`/api/contracts/${contractId}/deliver`).set(auth(token));

const detail = async (contractId: number, who: Actor): Promise<ContractWithHistory> =>
  (await request(app).get(`/api/contracts/${contractId}`).set(auth(who.token)).expect(200))
    .body as ContractWithHistory;

const download = (url: string, token?: string) => {
  const req = request(app).get(url);
  return (token ? req.set(auth(token)) : req).buffer(true).parse(binary);
};

/** Anexos de arquivo gravados no chat do par (o que a entrega deixa no banco). */
async function fileMessages(a: Actor, b: Actor): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
      WHERE m.has_file = 1
        AND cv.participant_a = LEAST(:a, :b) AND cv.participant_b = GREATEST(:a, :b)`,
    { a: a.id, b: b.id },
  );
  return Number(rows[0]!.n);
}

const diskCount = async (): Promise<number> => (await listUploadedFiles()).length;

afterAll(async () => {
  await pool.end();
});

describe('Entrega com arquivo (RF-035)', () => {
  it('multipart: a entrega grava mensagem, links e arquivos; as partes baixam, terceiro e anônimo não', async () => {
    const { client, freelancer, contractId } = await acceptedContract();

    const res = await deliverRequest(contractId, freelancer.token)
      .field('message', 'Logo e manual da marca')
      .field('files', 'https://drive.escambo.test/marca')
      .field('files', 'https://figma.escambo.test/arquivo')
      .attach('attachments', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .attach('attachments', PDF, {
        filename: '../manual "final".pdf',
        contentType: 'application/octet-stream', // o declarado é ignorado
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('delivered');

    for (const who of [client, freelancer]) {
      const c = await detail(contractId, who);
      expect(c.deliveries).toHaveLength(1);
      expect(c.deliveries![0]).toMatchObject({
        message: 'Logo e manual da marca',
        files: ['https://drive.escambo.test/marca', 'https://figma.escambo.test/arquivo'],
      });
      expect(c.deliveries![0]!.attachments).toEqual([
        expect.objectContaining({
          name: 'logo.png',
          mime: 'image/png',
          size: PNG.length,
          purgedAt: null,
          purgedReason: null,
          removedAt: null,
        }),
        expect.objectContaining({ name: 'manual final.pdf', mime: 'application/pdf' }),
      ]);
    }
    const [png, pdf] = (await detail(contractId, client)).deliveries![0]!.attachments!;
    expect(png!.url).toBe(`/api/messaging/attachments/${png!.messageId}`);

    // As duas partes baixam, com o mesmo tratamento do anexo do chat.
    const byClient = await download(png!.url, client.token);
    expect(byClient.status).toBe(200);
    expect(byClient.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(byClient.body as Buffer, PNG)).toBe(0);
    const byFreelancer = await download(pdf!.url, freelancer.token);
    expect(byFreelancer.status).toBe(200);
    expect(byFreelancer.headers['content-disposition']).toContain('attachment;');
    expect(Buffer.compare(byFreelancer.body as Buffer, PDF)).toBe(0);

    // Terceiro: não lê a contratação nem baixa o arquivo; sem token, 401.
    const stranger = await registerAndLogin('client');
    await request(app).get(`/api/contracts/${contractId}`).set(auth(stranger.token)).expect(403);
    const denied = await download(png!.url, stranger.token);
    expect(denied.status).toBe(403);
    expect((await download(png!.url)).status).toBe(401);

    // Os arquivos estão no chat do par, como mensagens do freelancer, sem legenda.
    const history = await request(app)
      .get(`/api/messaging/contracts/${contractId}`)
      .set(auth(client.token))
      .expect(200);
    const files = (history.body.messages as ChatMessage[]).filter((m) => m.attachment);
    expect(files.map((m) => [m.id, m.senderId, m.type, m.content])).toEqual([
      [png!.messageId, freelancer.id, 'image', ''],
      [pdf!.messageId, freelancer.id, 'file', ''],
    ]);
  });

  it('reentrega: cada entrega fica com os seus arquivos; sem arquivo, o JSON de sempre continua valendo', async () => {
    const { client, freelancer, contractId } = await acceptedContract();
    await deliverRequest(contractId, freelancer.token)
      .send({ message: 'Primeira versão, só com o link', files: ['https://drive.escambo.test/v1'] })
      .expect(200);
    await request(app)
      .post(`/api/contracts/${contractId}/request-revision`)
      .set(auth(client.token))
      .send({ note: 'Trocar a cor do logo' })
      .expect(200);
    const second = await deliverRequest(contractId, freelancer.token)
      .field('message', 'Cor trocada')
      .attach('attachments', ZIP, { filename: 'fontes.zip', contentType: 'application/zip' });
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    const c = await detail(contractId, client);
    expect(
      c.deliveries!.map((d) => [d.message, d.files, d.attachments!.map((a) => a.name)]),
    ).toEqual([
      ['Primeira versão, só com o link', ['https://drive.escambo.test/v1'], []],
      ['Cor trocada', [], ['fontes.zip']],
    ]);
  });

  it('recusas: tipo pelo conteúdo, vazio, mais de 10, acima do limite, soma acima, campo errado e quem não entrega; nada fica no disco nem no banco', async () => {
    const { client, freelancer, contractId } = await acceptedContract();
    const before = await diskCount();
    const send = () => deliverRequest(contractId, freelancer.token).field('message', 'Pronto');

    const html = await send().attach('attachments', Buffer.from('<html><script>x</script>'), {
      filename: 'foto.png',
      contentType: 'image/png',
    });
    expect([html.status, html.body.error]).toEqual([422, 'unsupported_file_type']);
    expect(html.body.message).toBe(
      'Tipo de arquivo não aceito: envie JPG, PNG, GIF, WebP, PDF ou ZIP',
    );

    // Com vários, a recusa diz qual arquivo, e nenhum deles é gravado.
    const mixed = await send()
      .attach('attachments', PNG, { filename: 'ok.png', contentType: 'image/png' })
      .attach('attachments', Buffer.from('texto'), { filename: 'nota.txt' });
    expect([mixed.status, mixed.body.message]).toEqual([
      422,
      'Tipo de arquivo não aceito (nota.txt): envie JPG, PNG, GIF, WebP, PDF ou ZIP',
    ]);

    const empty = await send().attach('attachments', Buffer.alloc(0), { filename: 'vazio.pdf' });
    expect([empty.status, empty.body.error]).toEqual([422, 'empty_file']);

    let eleven = send();
    for (let i = 0; i < 11; i++) {
      eleven = eleven.attach('attachments', PDF, { filename: `parte-${i}.pdf` });
    }
    const tooMany = await eleven;
    expect([tooMany.status, tooMany.body.error, tooMany.body.message]).toEqual([
      422,
      'invalid_upload',
      'Envie no máximo 10 arquivos de uma vez',
    ]);

    const big = await send().attach(
      'attachments',
      Buffer.concat([PDF, Buffer.alloc(10 * MB + 1)]),
      { filename: 'grande.pdf' },
    );
    expect([big.status, big.body.error]).toEqual([413, 'file_too_large']);

    let heavy = send();
    for (let i = 0; i < 3; i++) {
      heavy = heavy.attach('attachments', Buffer.concat([PDF, Buffer.alloc(9 * MB)]), {
        filename: `pesado-${i}.pdf`,
      });
    }
    const sum = await heavy;
    expect([sum.status, sum.body.error]).toEqual([413, 'files_too_large']);

    const wrongField = await send().attach('file', PDF, { filename: 'final.pdf' });
    expect([wrongField.status, wrongField.body.message]).toEqual([
      422,
      'Envio inválido: os arquivos vão no campo "attachments"',
    ]);

    // O cliente não entrega (RF-035): recusado antes de qualquer arquivo ir para o disco.
    const byClient = await deliverRequest(contractId, client.token)
      .field('message', 'Eu mesmo entrego')
      .attach('attachments', PDF, { filename: 'final.pdf' });
    expect(byClient.status).toBe(403);

    expect(await diskCount()).toBe(before);
    expect(await fileMessages(client, freelancer)).toBe(0);
    const c = await detail(contractId, client);
    expect(c.status).toBe('accepted');
    expect(c.deliveries).toEqual([]);
  });

  it('entrega de marco: leva arquivos como a única; links não têm onde ficar e são recusados', async () => {
    const { client, freelancer, contractId } = await acceptedContract([
      { title: 'Layout', amount: 150 },
      { title: 'Publicação', amount: 150 },
    ]);
    const [layout, publication] = (await detail(contractId, client)).milestones;

    // A entrega única não vale por marcos, com ou sem arquivo.
    const single = await deliverRequest(contractId, freelancer.token)
      .field('message', 'Tudo')
      .attach('attachments', PDF, { filename: 'tudo.pdf' });
    expect([single.status, single.body.error]).toEqual([409, 'use_milestones']);

    const links = await request(app)
      .post(`/api/contracts/${contractId}/milestones/${layout!.id}/deliver`)
      .set(auth(freelancer.token))
      .field('message', 'Layout')
      .field('files', 'https://figma.escambo.test/layout')
      .attach('attachments', PDF, { filename: 'layout.pdf' });
    expect([links.status, links.body.error]).toEqual([422, 'validation_error']);
    expect(links.body.details.files).toEqual([
      'A entrega de um marco não leva links: anexe os arquivos ou escreva o link na mensagem',
    ]);

    const res = await request(app)
      .post(`/api/contracts/${contractId}/milestones/${layout!.id}/deliver`)
      .set(auth(freelancer.token))
      .field('message', 'Layout aprovado no Figma')
      .attach('attachments', PDF, { filename: 'layout.pdf' })
      .attach('attachments', PNG, { filename: 'tela.png', contentType: 'image/png' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const c = await detail(contractId, client);
    const delivered = c.milestones.find((m) => m.id === layout!.id)!;
    expect(delivered.status).toBe('delivered');
    expect(delivered.attachments!.map((a) => [a.name, a.mime])).toEqual([
      ['layout.pdf', 'application/pdf'],
      ['tela.png', 'image/png'],
    ]);
    expect(c.milestones.find((m) => m.id === publication!.id)!.attachments).toEqual([]);
    expect(c.deliveries).toEqual([]);
    const dl = await download(delivered.attachments![0]!.url, client.token);
    expect(dl.status).toBe(200);
  });

  it('moderação e retenção: o arquivo removido some da entrega e não baixa; o expurgado aparece com o motivo', async () => {
    const { client, freelancer, contractId } = await acceptedContract();
    await deliverRequest(contractId, freelancer.token)
      .field('message', 'Entrega com dois arquivos')
      .attach('attachments', PNG, { filename: 'impróprio.png', contentType: 'image/png' })
      .attach('attachments', PDF, { filename: 'contrato.pdf' })
      .expect(200);
    const [bad, kept] = (await detail(contractId, client)).deliveries![0]!.attachments!;

    // O cliente denuncia o arquivo (é uma mensagem do chat) e a moderação remove (ADR 44).
    const admin = await registerAndLogin('client', true);
    const report = await request(app)
      .post('/api/reports')
      .set(auth(client.token))
      .send({ targetType: 'message', targetId: bad!.messageId, reason: 'offensive' });
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    await request(app)
      .post(`/api/admin/reports/${report.body.id}/remove-content`)
      .set(auth(admin.token))
      .send({ note: 'Imagem ofensiva.' })
      .expect(200);

    for (const who of [client, freelancer]) {
      const [removed] = (await detail(contractId, who)).deliveries![0]!.attachments!;
      expect(removed).toMatchObject({
        messageId: bad!.messageId,
        name: '',
        size: 0,
        removedAt: expect.any(String),
      } satisfies Partial<DeliveryAttachment>);
    }
    const gone = await download(bad!.url, client.token);
    expect(gone.status).toBe(410);

    // Contratação encerrada e anexo velho: a retenção tira o arquivo e a entrega diz por quê.
    await request(app)
      .post(`/api/contracts/${contractId}/approve`)
      .set(auth(client.token))
      .expect(200);
    const [row] = await pool.query<RowDataPacket[]>('SELECT file_url FROM messages WHERE id = ?', [
      kept!.messageId,
    ]);
    const key = String(row[0]!.file_url);
    await pool.query(
      'UPDATE messages SET created_at = NOW() - INTERVAL 400 DAY WHERE id IN (?, ?)',
      [kept!.messageId, bad!.messageId],
    );
    await runPurgeAttachments({ force: true, trigger: 'admin' });

    const purged = (await detail(contractId, freelancer)).deliveries![0]!.attachments![1]!;
    expect(purged).toMatchObject({
      name: 'contrato.pdf',
      purgedAt: expect.any(String),
      purgedReason: 'retention',
      removedAt: null,
    });
    await expect(stat(attachmentPath(key)!)).rejects.toMatchObject({ code: 'ENOENT' });
    const expired = await download(kept!.url, freelancer.token);
    expect(expired.status).toBe(410);
  });
});
