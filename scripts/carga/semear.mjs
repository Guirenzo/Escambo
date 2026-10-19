/**
 * Massa de dados do teste de carga, criada pela própria API HTTP (o mesmo caminho do front):
 * centenas de contas (freelancers e clientes), perfis com cidade e coordenadas, milhares de
 * serviços, saldo na carteira dos clientes (depósito PIX pelo gateway simulado) e as propostas
 * que abrem as Salas usadas no teste de WebSocket.
 *
 * Único atalho fora da API: o e-mail das contas de teste é marcado como confirmado direto no
 * banco de carga (o mesmo UPDATE que o link de confirmação faz), porque o saque exige e-mail
 * confirmado (ADR 20) e o link só existe na caixa de saída simulada.
 */

import mysql from 'mysql2/promise';
import { criarCliente, emParalelo, exigir, geradorAleatorio, gravarEstado, log } from './lib.mjs';

const SENHA = 'Carga@12345';
const DOMINIO = 'carga.test';

const BASES = [
  'Landing page em React',
  'Site institucional em WordPress',
  'Loja virtual completa',
  'App mobile em React Native',
  'API REST em Node.js',
  'Automação de planilhas no Excel',
  'Identidade visual e logo',
  'Criação de logo minimalista',
  'Posts para Instagram',
  'Gestão de tráfego pago',
  'Consultoria de marketing digital',
  'Tradução inglês-português',
  'Revisão de textos acadêmicos',
  'Aulas de violão online',
  'Aulas de inglês para iniciantes',
  'Ensaio fotográfico externo',
  'Fotografia de produtos',
  'Edição de vídeo para YouTube',
  'Motion design para vídeos curtos',
  'Manutenção de computadores',
  'Instalação elétrica residencial',
  'Pequenos reparos hidráulicos',
  'Montagem de móveis',
  'Personal trainer',
  'Plano alimentar com nutricionista',
  'Organização de eventos',
  'Bolo de aniversário personalizado',
  'Assessoria contábil para MEI',
  'Design de interiores',
  'Passeio com cachorro',
];

const MODIFICADORES = [
  'para pequenas empresas',
  'com entrega rápida',
  'sob medida',
  'profissional',
  'com suporte por 30 dias',
  'para iniciantes',
  'completo',
  'econômico',
  'premium',
  '',
];

const FRASES = [
  'Atendo com cuidado desde o primeiro contato até a entrega final.',
  'Trabalho com prazos claros e mantenho você informado em cada etapa.',
  'Tenho experiência com clientes de vários segmentos e portes.',
  'O orçamento inclui uma rodada de ajustes sem custo adicional.',
  'Antes de começar, faço uma conversa rápida para entender o que você precisa.',
  'Uso ferramentas atuais e entrego os arquivos organizados.',
  'Posso atender presencialmente na região ou de forma remota.',
  'Todo o material fica com você ao final do trabalho.',
  'Envio prévias para aprovação antes da versão definitiva.',
  'Valores especiais para pacotes e trabalhos recorrentes.',
  'Já concluí mais de cem trabalhos parecidos com avaliações positivas.',
  'Respondo as mensagens no mesmo dia, inclusive aos sábados.',
  'Indico o melhor caminho para o seu orçamento sem empurrar extras.',
  'Documentação e orientações de uso fazem parte da entrega.',
  'Se algo não ficar como combinado, ajusto até ficar certo.',
];

const NOMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabriela', 'Heitor', 'Iara'];
const SOBRENOMES = ['Silva', 'Souza', 'Costa', 'Pereira', 'Oliveira', 'Lima', 'Ramos', 'Teixeira'];

export const CIDADES = [
  { city: 'Joinville', state: 'SC', lat: -26.3045, lng: -48.8487 },
  { city: 'Florianópolis', state: 'SC', lat: -27.5954, lng: -48.548 },
  { city: 'Blumenau', state: 'SC', lat: -26.9194, lng: -49.0661 },
  { city: 'Curitiba', state: 'PR', lat: -25.4284, lng: -49.2733 },
  { city: 'São Paulo', state: 'SP', lat: -23.5505, lng: -46.6333 },
  { city: 'Porto Alegre', state: 'RS', lat: -30.0346, lng: -51.2177 },
  { city: 'Rio de Janeiro', state: 'RJ', lat: -22.9068, lng: -43.1729 },
  { city: 'Belo Horizonte', state: 'MG', lat: -19.9167, lng: -43.9345 },
];

function achatarCategorias(arvore, saida = []) {
  for (const c of arvore) {
    saida.push(c.id);
    if (Array.isArray(c.children)) achatarCategorias(c.children, saida);
  }
  return saida;
}

/**
 * Cria a massa e devolve o estado (tokens e ids) usado pelos testes.
 * `cfg`: { apiUrl, db, freelancers, clientes, servicos, paresWs }.
 */
export async function semear(cfg) {
  const g = geradorAleatorio(20261019);
  const api = criarCliente(cfg.apiUrl, { maxSockets: 32 });
  const t0 = Date.now();

  const categorias = achatarCategorias(await exigir(api.req('GET', '/categories', { json: true })));
  log(`seed: ${categorias.length} categorias ativas`);

  const contas = [
    ...Array.from({ length: cfg.freelancers }, (_, i) => ({
      papel: 'freelancer',
      email: `f${String(i + 1).padStart(4, '0')}@${DOMINIO}`,
    })),
    ...Array.from({ length: cfg.clientes }, (_, i) => ({
      papel: 'client',
      email: `c${String(i + 1).padStart(4, '0')}@${DOMINIO}`,
    })),
  ];

  // Cadastro e login custam um bcrypt (12 rodadas) cada: é a parte lenta do seed.
  await emParalelo(contas, 8, async (c) => {
    const r = await api.req('POST', '/auth/register', {
      body: {
        email: c.email,
        password: SENHA,
        role: c.papel,
        timezone: 'America/Sao_Paulo',
        legalAccepted: true,
      },
    });
    if (r.status !== 201 && r.status !== 409) {
      throw new Error(`cadastro de ${c.email}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    }
  });
  log(`seed: ${contas.length} contas cadastradas (${Math.round((Date.now() - t0) / 1000)} s)`);

  const conn = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
  });
  try {
    await conn.query(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()),
              status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END
        WHERE email LIKE ?`,
      [`%@${DOMINIO}`],
    );
  } finally {
    await conn.end();
  }

  await emParalelo(contas, 8, async (c) => {
    const d = await exigir(
      api.req('POST', '/auth/login', { body: { email: c.email, password: SENHA }, json: true }),
    );
    c.token = d.accessToken;
    c.uid = d.user.id;
    c.ulid = d.user.ulid;
  });
  log(`seed: login de ${contas.length} contas (${Math.round((Date.now() - t0) / 1000)} s)`);

  const freelancers = contas.filter((c) => c.papel === 'freelancer');
  const clientes = contas.filter((c) => c.papel === 'client');

  await emParalelo(freelancers, 16, async (f) => {
    const cidade = g.pick(CIDADES);
    const dias = [1, 2, 3, 4, 5, 6, 0].filter(() => g.rnd() < 0.7);
    await exigir(
      api.req('PUT', '/profiles/freelancer', {
        token: f.token,
        body: {
          fullName: `${g.pick(NOMES)} ${g.pick(SOBRENOMES)}`,
          headline: g.pick(BASES),
          bio: `${g.pick(FRASES)} ${g.pick(FRASES)}`,
          city: cidade.city,
          state: cidade.state,
          latitude: cidade.lat + (g.rnd() - 0.5) * 0.1,
          longitude: cidade.lng + (g.rnd() - 0.5) * 0.1,
          isAvailable: true,
          availableDays: dias.length ? dias : null,
        },
      }),
    );
  });
  log(`seed: ${freelancers.length} perfis de freelancer`);

  const pedidos = Array.from({ length: cfg.servicos }, (_, i) => {
    const dono = freelancers[i % freelancers.length];
    const tipo = g.rnd();
    const priceType = tipo < 0.7 ? 'fixed' : tipo < 0.9 ? 'hourly' : 'negotiable';
    const frases = Array.from({ length: g.int(3, 7) }, () => g.pick(FRASES));
    const base = g.pick(BASES);
    return {
      dono,
      body: {
        categoryId: g.pick(categorias),
        title: `${base} ${g.pick(MODIFICADORES)}`.trim().slice(0, 150),
        description: `${base}. ${frases.join(' ')}`,
        priceType,
        price:
          priceType === 'fixed' ? g.int(30, 5000) : priceType === 'hourly' ? g.int(40, 200) : null,
        deliveryDays: g.rnd() < 0.85 ? g.int(1, 45) : null,
        isRemote: g.rnd() < 0.5,
      },
    };
  });
  const servicos = await emParalelo(pedidos, 16, async (p) => {
    const s = await exigir(
      api.req('POST', '/services', { token: p.dono.token, body: p.body, json: true }),
    );
    return { id: s.id, donoUid: p.dono.uid };
  });
  log(`seed: ${servicos.length} serviços (${Math.round((Date.now() - t0) / 1000)} s)`);

  // Saldo para propostas (a reserva sai da carteira) e saques: depósito PIX + pagamento simulado.
  await emParalelo(clientes, 16, async (c) => {
    const dep = await exigir(
      api.req('POST', '/wallet/deposits', { token: c.token, body: { amount: 50000 }, json: true }),
    );
    await exigir(api.req('POST', `/wallet/deposits/${dep.id}/simulate`, { token: c.token }));
  });
  log(`seed: carteira de ${clientes.length} clientes com R$ 50.000`);

  // Salas do teste de WebSocket: uma proposta (contrato pendente) por par cliente i → freelancer i.
  const servicosPorDono = new Map();
  for (const s of servicos) {
    if (!servicosPorDono.has(s.donoUid)) servicosPorDono.set(s.donoUid, []);
    servicosPorDono.get(s.donoUid).push(s.id);
  }
  const paresWs = [];
  for (let i = 0; i < Math.min(cfg.paresWs, clientes.length, freelancers.length); i++) {
    const c = clientes[i];
    const f = freelancers[i];
    const contrato = await exigir(
      api.req('POST', '/contracts', {
        token: c.token,
        json: true,
        body: {
          freelancerId: f.uid,
          serviceId: servicosPorDono.get(f.uid)[0],
          title: 'Proposta da Sala de carga',
          description: 'Contrato usado para medir a entrega de mensagens em tempo real.',
          price: 50,
          paymentMode: 'cash',
        },
      }),
    );
    paresWs.push({ contratoId: contrato.id, cliente: i, freelancer: i });
  }
  log(`seed: ${paresWs.length} Salas (propostas) para o teste de WebSocket`);

  api.fechar();
  const estado = {
    criadoEm: new Date().toISOString(),
    apiUrl: cfg.apiUrl,
    jwtSecret: cfg.jwtSecret,
    categorias,
    freelancers: freelancers.map(({ uid, ulid, token }) => ({ uid, ulid, token })),
    clientes: clientes.map(({ uid, ulid, token }) => ({ uid, ulid, token })),
    servicos,
    paresWs,
    // Próximo par cliente→freelancer livre para proposta (RN-020: um aberto por par).
    cursorPares: 0,
    segundosSeed: Math.round((Date.now() - t0) / 1000),
  };
  gravarEstado(estado);
  return estado;
}
