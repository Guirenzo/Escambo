import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { currentSlot, PERIODS } from '../../src/modules/profiles/availability';

/**
 * Horário de atendimento no fuso do freelancer (ADR 48) contra o MySQL real: quem escolheu Rio
 * Branco tem a agenda lida no relógio de lá. A busca "atende agora", o selo do card e o perfil
 * público concordam entre si e com o cálculo do módulo; o fuso vai junto no card e no perfil.
 */

const app = createApp();
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const TAG = `fuso${Date.now()}`;

interface Freela {
  id: number;
  token: string;
  ulid: string;
}

let seq = 0;
async function freelancer(zone: string | null): Promise<Freela> {
  const email = `int_fuso_${Date.now()}_${seq++}@escambo.test`;
  const password = 'senha-integracao-123';
  await request(app)
    .post('/api/auth/register')
    .send({ email, password, role: 'freelancer' })
    .expect(201);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  const token = login.body.accessToken as string;
  if (zone) {
    await request(app)
      .put('/api/notifications/preferences')
      .set(auth(token))
      .send({ timezone: zone })
      .expect(200);
  }
  return { id: login.body.user.id, token, ulid: login.body.user.ulid };
}

const agenda = (f: Freela, periods: Record<string, string[]> | null) =>
  request(app)
    .put('/api/profiles/freelancer')
    .set(auth(f.token))
    .send({
      fullName: 'Freela do Fuso',
      city: 'Rio Branco',
      isAvailable: true,
      availableDays: [0, 1, 2, 3, 4, 5, 6],
      availablePeriods: periods,
    })
    .expect(200);

async function publish(owner: Freela, title: string): Promise<void> {
  const cats = await request(app).get('/api/categories').expect(200);
  const list = (Array.isArray(cats.body) ? cats.body : cats.body.items) as { id: number }[];
  await request(app)
    .post('/api/services')
    .set(auth(owner.token))
    .send({
      categoryId: list[0]!.id,
      title: `${TAG} ${title}`,
      description: 'Serviço usado para testar o atendimento no fuso do freelancer',
      priceType: 'fixed',
      price: 100,
    })
    .expect(201);
}

interface Item {
  title: string;
  ownerAvailableNow: boolean;
  ownerTimezone: string;
}
const search = async (query = ''): Promise<Item[]> => {
  const res = await request(app).get(`/api/services?q=${TAG}&limit=50${query}`).expect(200);
  return (res.body.items as Item[]).filter((i) => i.title.startsWith(TAG));
};
const names = (items: Item[]): string[] => items.map((i) => i.title.slice(TAG.length + 1)).sort();

afterAll(async () => {
  await pool.end();
});

describe('Atendimento no fuso do freelancer (ADR 48)', () => {
  it('"atende agora", selo e perfil público leem a agenda no fuso de cada um', async () => {
    const now = new Date();
    const acre = currentSlot(now, 'America/Rio_Branco');
    const brt = currentSlot(now, 'America/Sao_Paulo');
    const other = (p: string | null) => PERIODS.find((x) => x !== p)!;
    // Virou o período (ou o dia) em algum dos dois fusos no meio do teste: as leituras feitas
    // até aqui não são comparáveis com o que foi calculado no começo (mesma guarda do ADR 34).
    const moved = (): boolean => {
      const a = currentSlot(new Date(), 'America/Rio_Branco');
      const b = currentSlot(new Date(), 'America/Sao_Paulo');
      return (
        a.day !== acre.day ||
        a.period !== acre.period ||
        b.day !== brt.day ||
        b.period !== brt.period
      );
    };

    const noAcre = await freelancer('America/Rio_Branco');
    const emBrasilia = await freelancer(null);
    // Cada um marca, no dia de hoje do seu fuso, só o período de agora lá (se for madrugada lá,
    // marca um período qualquer: não pode aparecer de jeito nenhum).
    const savedAcre = await agenda(noAcre, { [String(acre.day)]: [acre.period ?? 'morning'] });
    expect(savedAcre.body).toMatchObject({ timezone: 'America/Rio_Branco' });
    await agenda(emBrasilia, { [String(brt.day)]: [brt.period ?? 'morning'] });
    await publish(noAcre, 'acre');
    await publish(emBrasilia, 'brasilia');

    const items = await search();
    const nowItems = await search('&now=true');
    const pub = await request(app).get(`/api/profiles/freelancer/${noAcre.ulid}`).expect(200);
    if (moved()) return;
    expect(items.find((i) => i.title.endsWith('acre'))).toMatchObject({
      ownerTimezone: 'America/Rio_Branco',
      ownerAvailableNow: acre.period !== null,
    });
    expect(items.find((i) => i.title.endsWith('brasilia'))).toMatchObject({
      ownerTimezone: 'America/Sao_Paulo',
      ownerAvailableNow: brt.period !== null,
    });
    const expectedNow = [
      ...(acre.period ? ['acre'] : []),
      ...(brt.period ? ['brasilia'] : []),
    ].sort();
    expect(names(nowItems)).toEqual(expectedNow);
    expect(pub.body).toMatchObject({
      timezone: 'America/Rio_Branco',
      availableNow: acre.period !== null,
    });

    // Trocando para o período que NÃO é o de agora no Acre, ele some da busca e o selo apaga,
    // mesmo que esse período seja o de agora em Brasília.
    await agenda(noAcre, { [String(acre.day)]: [other(acre.period)] });
    const nowAfter = await search('&now=true');
    const itemsAfter = await search();
    const pubAfter = await request(app).get(`/api/profiles/freelancer/${noAcre.ulid}`).expect(200);
    if (moved()) return;
    expect(names(nowAfter)).toEqual(brt.period ? ['brasilia'] : []);
    expect(itemsAfter.find((i) => i.title.endsWith('acre'))).toMatchObject({
      ownerAvailableNow: false,
    });
    expect(pubAfter.body.availableNow).toBe(false);

    // Dia inteiro marcado (sem períodos): atende agora sempre que não for madrugada no Acre.
    await agenda(noAcre, null);
    const nowAllDay = await search('&now=true');
    if (moved()) return;
    expect(names(nowAllDay)).toEqual(expectedNow);
  });
});
