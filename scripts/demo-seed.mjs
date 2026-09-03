#!/usr/bin/env node
/**
 * Dados de demonstração do Escambo.
 *
 * Popula uma instância em execução (dev ou docker compose) usando a própria API HTTP,
 * exatamente como o front faz: 6 freelancers com perfil + localização, 1 cliente,
 * serviços, contratações em todos os estados (pendente → aceita → entregue → aprovada),
 * chat, contratação em créditos, impulsionamento e trocas de serviço.
 *
 *   npm run demo:seed                                     # API em http://localhost:3333/api
 *   API_URL=http://localhost:8090/api npm run demo:seed   # stack do docker compose (via nginx)
 *
 * Idempotente: contas/serviços/contratações já existentes são reaproveitados.
 * Todas as contas usam a senha  Escambo@123
 *
 * Sem dependências — só Node 20+ (fetch nativo).
 */

const API = (process.env.API_URL ?? 'http://localhost:3333/api').replace(/\/$/, '');
const PASSWORD = 'Escambo@123';

// ---------------------------------------------------------------------------
// Catálogo da demo
// ---------------------------------------------------------------------------

const FREELANCERS = [
  {
    key: 'bruno',
    email: 'bruno@escambo.demo',
    profile: {
      fullName: 'Bruno Costa',
      headline: 'Dev Full Stack | 5 anos',
      bio: 'React, Node e MySQL. Entrego rápido e documentado.',
      city: 'Joinville',
      state: 'SC',
      latitude: -26.3045,
      longitude: -48.8487,
    },
    services: [
      {
        title: 'Landing page em React',
        price: 1200,
        deliveryDays: 7,
        category: ['tecnologia', 'desenvolvimento', 'web'],
      },
      {
        title: 'App mobile (React Native)',
        price: 4500,
        deliveryDays: 30,
        category: ['tecnologia', 'desenvolvimento', 'mobile'],
      },
      {
        title: 'Ajustes e correções no site',
        price: 400,
        deliveryDays: 3,
        category: ['tecnologia', 'desenvolvimento', 'web'],
      },
    ],
  },
  {
    key: 'marina',
    email: 'marina@escambo.demo',
    profile: {
      fullName: 'Marina Alves',
      headline: 'Designer de marca | 8 anos',
      bio: 'Identidade visual com estratégia: logo, paleta, tipografia e guia de uso.',
      city: 'Joinville',
      state: 'SC',
      latitude: -26.2992,
      longitude: -48.8461,
    },
    services: [
      {
        title: 'Identidade visual (logo + guia)',
        price: 800,
        deliveryDays: 10,
        category: ['design', 'criativ'],
      },
      {
        title: 'Posts para redes sociais (pacote 12)',
        price: 480,
        deliveryDays: 5,
        category: ['design', 'marketing'],
      },
    ],
  },
  {
    key: 'rafael',
    email: 'rafael@escambo.demo',
    profile: {
      fullName: 'Rafael Souza',
      headline: 'Motion designer',
      bio: 'Animações curtas para redes, vinhetas e explainers.',
      city: 'Blumenau',
      state: 'SC',
      latitude: -26.9194,
      longitude: -49.0661,
    },
    services: [
      {
        title: 'Motion graphics 15s',
        price: 900,
        deliveryDays: 7,
        category: ['design', 'vídeo', 'video', 'audiovisual'],
      },
    ],
  },
  {
    key: 'carla',
    email: 'carla@escambo.demo',
    profile: {
      fullName: 'Carla Dias',
      headline: 'Fotógrafa de produto',
      bio: 'Fotos limpas para e-commerce e cardápio.',
      city: 'Florianópolis',
      state: 'SC',
      latitude: -27.5954,
      longitude: -48.548,
    },
    services: [
      {
        title: 'Ensaio de produto (20 fotos)',
        price: 650,
        deliveryDays: 4,
        category: ['foto', 'audiovisual', 'design'],
      },
    ],
  },
  {
    key: 'diego',
    email: 'diego@escambo.demo',
    profile: {
      fullName: 'Diego Ramos',
      headline: 'Redator e SEO',
      bio: 'Conteúdo que ranqueia e converte.',
      city: 'Curitiba',
      state: 'PR',
      latitude: -25.4284,
      longitude: -49.2733,
    },
    services: [
      {
        title: 'Pacote de 4 artigos SEO',
        price: 700,
        deliveryDays: 10,
        category: ['marketing', 'redação', 'redacao', 'conteúdo'],
      },
    ],
  },
  {
    key: 'felipe',
    email: 'felipe@escambo.demo',
    profile: {
      fullName: 'Felipe Nunes',
      headline: 'Eletricista residencial',
      bio: 'Instalações, reparos e laudos. Atendo Joinville e região.',
      city: 'Joinville',
      state: 'SC',
      latitude: -26.3211,
      longitude: -48.8536,
    },
    services: [
      {
        title: 'Instalação elétrica (visita)',
        price: 250,
        deliveryDays: 1,
        isRemote: false,
        category: ['casa', 'reforma', 'reparo', 'serviços gerais'],
      },
    ],
  },
];

const CLIENT = {
  key: 'ana',
  email: 'cliente@escambo.demo',
  profile: { fullName: 'Ana Pereira', city: 'Joinville', state: 'SC' },
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message, path) {
    super(`${status} ${path}: ${message}`);
    this.status = status;
  }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? data.error ?? res.statusText, path);
  return data;
}

/** Listas paginadas da API vêm como { items, total, ... }; aceita variações. */
const items = (res) => (Array.isArray(res) ? res : (res?.items ?? res?.data ?? []));

const log = (msg) => console.log(`  ${msg}`);
const step = (msg) => console.log(`\n▶ ${msg}`);

// ---------------------------------------------------------------------------
// Passos
// ---------------------------------------------------------------------------

async function ensureAccount(email, role) {
  try {
    await call('POST', '/auth/register', { body: { email, password: PASSWORD, role } });
    log(`criada   ${email}`);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
    log(`existe   ${email}`);
  }
  let auth;
  try {
    auth = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      throw new Error(
        'Limite de tentativas de login atingido (10 a cada 5 min). Aguarde alguns minutos e rode de novo.',
      );
    }
    throw err;
  }
  return { email, token: auth.accessToken, id: auth.user.id };
}

function pickCategory(categories, hints) {
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const hint of hints) {
    const found = categories.find(
      (c) => norm(c.name).includes(norm(hint)) || norm(c.slug ?? '').includes(norm(hint)),
    );
    if (found) return found.id;
  }
  return categories[0].id;
}

async function ensureService(user, spec, categories) {
  const existing = items(
    await call('GET', `/services?q=${encodeURIComponent(spec.title)}&limit=20`, {
      token: user.token,
    }),
  ).find((s) => s.ownerId === user.id && s.title === spec.title);
  if (existing) return existing;
  const created = await call('POST', '/services', {
    token: user.token,
    body: {
      categoryId: pickCategory(categories, spec.category),
      title: spec.title,
      description: `${spec.title}. Escopo fechado, prazo de ${spec.deliveryDays} dia(s), revisão inclusa.`,
      priceType: 'fixed',
      price: spec.price,
      deliveryDays: spec.deliveryDays,
      isRemote: spec.isRemote ?? true,
    },
  });
  log(`serviço  ${spec.title} (R$ ${spec.price})`);
  return created;
}

/**
 * Cria (se não existir) uma contratação da cliente para o freelancer e a leva até o
 * estado pedido: 'pending' | 'accepted' | 'delivered' | 'completed'.
 */
async function ensureContract(
  client,
  freelancer,
  service,
  { title, price, paymentMode = 'cash', to, chat = [] },
) {
  const mine = items(await call('GET', '/contracts', { token: client.token }));
  let contract = mine.find((c) => c.title === title && c.freelancerId === freelancer.id);
  if (!contract) {
    contract = await call('POST', '/contracts', {
      token: client.token,
      body: {
        freelancerId: freelancer.id,
        serviceId: service.id,
        title,
        description: `Contratação do serviço "${service.title}" para a demo do Escambo.`,
        price,
        paymentMode,
      },
    });
    log(`contrato #${contract.id} ${title} (${paymentMode}) → pendente`);
  } else {
    log(`contrato #${contract.id} ${title} já existe (${contract.status})`);
  }

  const order = ['pending', 'accepted', 'delivered', 'completed'];
  const at = (s) => order.indexOf(s);
  let status = contract.status === 'in_progress' ? 'accepted' : contract.status;
  if (at(status) < 0) return contract; // cancelado/rejeitado: não mexe

  if (at(status) < at('accepted') && at(to) >= at('accepted')) {
    contract = await call('POST', `/contracts/${contract.id}/accept`, { token: freelancer.token });
    status = 'accepted';
    log(`  aceita pelo freelancer`);
  }
  if (chat.length && at(status) >= at('accepted')) {
    const history = await call('GET', `/messaging/contracts/${contract.id}`, {
      token: client.token,
    });
    if (items(history.messages ?? history).length === 0) {
      for (const [who, content] of chat) {
        await call('POST', `/messaging/contracts/${contract.id}`, {
          token: who === 'client' ? client.token : freelancer.token,
          body: { content },
        });
      }
      log(`  ${chat.length} mensagens no chat`);
    }
  }
  if (at(status) < at('delivered') && at(to) >= at('delivered')) {
    contract = await call('POST', `/contracts/${contract.id}/deliver`, {
      token: freelancer.token,
      body: { message: 'Entrega concluída. Arquivos e instruções enviados no chat.' },
    });
    status = 'delivered';
    log(`  entregue`);
  }
  if (at(status) < at('completed') && at(to) >= at('completed')) {
    contract = await call('POST', `/contracts/${contract.id}/approve`, { token: client.token });
    log(`  aprovada → concluída`);
  }
  return contract;
}

async function ensureBoost(user, service) {
  const active = (await call('GET', '/boosts', { token: user.token })).find(
    (b) => b.serviceId === service.id && b.status !== 'expired',
  );
  if (active) return log(`boost    ${service.title} já ativo`);
  const plans = await call('GET', '/boosts/plans', { token: user.token });
  const plan = [...plans].sort((a, b) => a.costCredits - b.costCredits)[0];
  await call('POST', '/boosts', {
    token: user.token,
    body: { serviceId: service.id, planId: plan.id },
  });
  log(`boost    ${service.title} com "${plan.name}" (${plan.costCredits} créditos)`);
}

async function ensureBarter(proposer, receiver, offered, requested, accept) {
  const mine = items(await call('GET', '/barters', { token: proposer.token }));
  let barter = mine.find(
    (b) => b.offeredServiceId === offered.id && b.requestedServiceId === requested.id,
  );
  if (!barter) {
    barter = await call('POST', '/barters', {
      token: proposer.token,
      body: {
        receiverId: receiver.id,
        offeredServiceId: offered.id,
        requestedServiceId: requested.id,
        estimatedValueOffered: offered.price,
        estimatedValueRequested: requested.price,
      },
    });
    log(`troca    ${offered.title} ⇄ ${requested.title} → proposta`);
  } else {
    log(`troca    ${offered.title} ⇄ ${requested.title} já existe (${barter.status})`);
  }
  if (accept && barter.status === 'proposed') {
    await call('POST', `/barters/${barter.id}/accept`, { token: receiver.token });
    log(`  aceita → 2 contratos recíprocos`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Escambo · dados de demonstração → ${API}`);
  const health = await call('GET', '/health').catch((e) => {
    throw new Error(
      `API indisponível em ${API} (${e.message}). Suba com \`npm run dev\` ou \`docker compose up -d --build\`.`,
    );
  });
  if (health.status && health.status !== 'ok')
    throw new Error(`API não está pronta: ${JSON.stringify(health)}`);

  step('Contas');
  const users = {};
  for (const f of FREELANCERS) users[f.key] = await ensureAccount(f.email, 'freelancer');
  users[CLIENT.key] = await ensureAccount(CLIENT.email, 'client');

  step('Perfis, carteiras (bônus de boas-vindas) e serviços');
  const categories = await call('GET', '/categories');
  const svc = {};
  for (const f of FREELANCERS) {
    const u = users[f.key];
    await call('PUT', '/profiles/freelancer', {
      token: u.token,
      body: { ...f.profile, isAvailable: true },
    });
    await call('GET', '/wallet', { token: u.token });
    for (const s of f.services) svc[s.title] = await ensureService(u, s, categories);
  }
  const ana = users.ana;
  await call('PUT', '/profiles/client', { token: ana.token, body: CLIENT.profile });
  await call('GET', '/wallet', { token: ana.token });

  step('Contratações (todos os estados do escrow)');
  await ensureContract(ana, users.bruno, svc['Landing page em React'], {
    title: 'Landing page em React',
    price: 1200,
    to: 'completed',
    chat: [
      ['client', 'Oi Bruno! Consegue entregar até sexta?'],
      ['freelancer', 'Consigo sim. Te mando o preview na quarta pra você validar.'],
      ['client', 'Perfeito, obrigada!'],
      ['freelancer', 'Preview no ar: https://preview.escambo.demo/landing — pode olhar?'],
    ],
  });
  await ensureContract(ana, users.bruno, svc['Ajustes e correções no site'], {
    title: 'Ajustes e correções no site',
    price: 400,
    to: 'completed',
  });
  await ensureContract(ana, users.marina, svc['Identidade visual (logo + guia)'], {
    title: 'Identidade visual (logo + guia)',
    price: 800,
    to: 'completed',
  });
  await ensureContract(ana, users.marina, svc['Posts para redes sociais (pacote 12)'], {
    title: 'Posts para redes sociais (pacote 12)',
    price: 480,
    to: 'delivered',
  });
  await ensureContract(ana, users.carla, svc['Ensaio de produto (20 fotos)'], {
    title: 'Ensaio de produto (20 fotos)',
    price: 650,
    to: 'completed',
  });
  await ensureContract(ana, users.rafael, svc['Motion graphics 15s'], {
    title: 'Motion graphics 15s',
    price: 900,
    to: 'accepted',
    chat: [
      ['client', 'Rafael, o vídeo é pro Instagram, formato 9:16.'],
      ['freelancer', 'Anotado. Já começo pelo storyboard e te mostro amanhã.'],
    ],
  });
  await ensureContract(ana, users.diego, svc['Pacote de 4 artigos SEO'], {
    title: 'Pacote de 4 artigos SEO',
    price: 700,
    to: 'pending',
  });
  await ensureContract(ana, users.felipe, svc['Instalação elétrica (visita)'], {
    title: 'Revisão elétrica rápida (em créditos)',
    price: 60,
    paymentMode: 'credits',
    to: 'completed',
  });

  step('Impulsionamento (pago em créditos Escambo)');
  await ensureBoost(users.bruno, svc['Landing page em React']);

  step('Trocas de serviço (escambo)');
  await ensureBarter(
    users.rafael,
    users.bruno,
    svc['Motion graphics 15s'],
    svc['Landing page em React'],
    true,
  );
  await ensureBarter(
    users.marina,
    users.bruno,
    svc['Identidade visual (logo + guia)'],
    svc['Landing page em React'],
    false,
  );

  console.log('\n✔ Demo pronta. Contas (senha Escambo@123):');
  console.log(`  cliente     ${CLIENT.email}`);
  for (const f of FREELANCERS)
    console.log(`  freelancer  ${f.email.padEnd(24)} ${f.profile.fullName}`);
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
