#!/usr/bin/env node
/**
 * Dados de demonstração do Escambo.
 *
 * Popula uma instância em execução (dev ou docker compose) usando a própria API HTTP,
 * exatamente como o front faz: 6 freelancers com perfil + localização, 1 cliente,
 * serviços, contratações em todos os estados (pendente → aceita → entregue → aprovada),
 * chat, contratação em créditos, impulsionamento, trocas de serviço, depósito PIX (gateway
 * simulado) na carteira da cliente e saques na fila do admin.
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
      avatarUrl: 'https://i.pravatar.cc/150?u=bruno@escambo.demo',
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
      avatarUrl: 'https://i.pravatar.cc/150?u=marina@escambo.demo',
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
      avatarUrl: 'https://i.pravatar.cc/150?u=rafael@escambo.demo',
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
      avatarUrl: 'https://i.pravatar.cc/150?u=carla@escambo.demo',
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
      avatarUrl: 'https://i.pravatar.cc/150?u=diego@escambo.demo',
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
      avatarUrl: 'https://i.pravatar.cc/150?u=felipe@escambo.demo',
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
  profile: {
    fullName: 'Ana Pereira',
    avatarUrl: 'https://i.pravatar.cc/150?u=cliente@escambo.demo',
    city: 'Joinville',
    state: 'SC',
  },
};

/** Admin da demo: vira admin por ADMIN_EMAILS (padrão do docker-compose: admin@escambo.demo). */
const ADMIN_EMAIL = 'admin@escambo.demo';

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

/** Confirma o e-mail da conta da demo pelo link da caixa de saída (provedor simulado). */
async function ensureVerified(user, admin) {
  const me = await call('GET', '/auth/me', { token: user.token });
  if (me.emailVerified) return;
  await call('POST', '/auth/resend-verification', { token: user.token }).catch(() => undefined);
  const emails = await call('GET', `/admin/emails?userId=${user.id}&limit=10`, {
    token: admin.token,
  });
  const mail = emails.find((e) => e.template === 'verify_email');
  const token = mail && /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  if (!token) return;
  await call('POST', '/auth/verify-email', { body: { token } });
  log(`e-mail confirmado: ${user.email}`);
}

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
  let contract = mine.find(
    (c) =>
      c.title === title &&
      c.freelancerId === freelancer.id &&
      !['cancelled', 'rejected'].includes(c.status),
  );
  if (!contract) {
    // Carteira pré-paga: a proposta em dinheiro reserva o valor do saldo da cliente.
    if (paymentMode === 'cash') await ensureBalance(client, price);
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

  // 'revision' = entregue e com revisão pedida pelo cliente (volta ao freelancer com o motivo)
  const wantsRevision = to === 'revision';
  if (wantsRevision) to = 'delivered';
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
  if (wantsRevision && (contract.status === 'delivered' || status === 'delivered')) {
    contract = await call('POST', `/contracts/${contract.id}/request-revision`, {
      token: client.token,
      body: { note: 'Ficou ótimo, só ajusta as cores do rodapé e o tamanho do logo.' },
    });
    log(`  revisão pedida pelo cliente`);
  }
  return contract;
}

/** Cliente avalia uma contratação concluída (uma vez por contrato). */
/** Garante saldo disponível na carteira (depósito PIX no gateway simulado + confirmação). */
async function ensureBalance(user, amount) {
  const w = await call('GET', '/wallet', { token: user.token });
  if (Number(w.balance) >= amount) return;
  const need = Math.max(100, Math.ceil((amount - Number(w.balance)) / 100) * 100);
  const deposit = await call('POST', '/wallet/deposits', {
    token: user.token,
    body: { amount: need, method: 'pix' },
  });
  await call('POST', `/wallet/deposits/${deposit.id}/simulate`, { token: user.token });
  log(`depósito PIX (simulado) de R$ ${need} confirmado para ${user.email}`);
}

/** Saque do freelancer (idempotente por valor); opcionalmente concluído pelo admin. */
async function ensureWithdrawal(user, admin, amount, pixKey, { complete = false } = {}) {
  const mine = items(await call('GET', '/withdrawals', { token: user.token }));
  let w = mine.find((x) => Number(x.amount) === amount && x.status !== 'cancelled' && x.status !== 'failed');
  if (!w) {
    w = await call('POST', '/withdrawals', {
      token: user.token,
      body: { amount, method: 'pix', pixKey },
    });
    log(`saque #${w.id} de R$ ${amount} solicitado por ${user.email}`);
  } else {
    log(`saque #${w.id} de R$ ${amount} já existe (${w.status})`);
  }
  if (complete && w.status !== 'completed') {
    w = await call('POST', `/admin/withdrawals/${w.id}/complete`, {
      token: admin.token,
      body: { gatewayRef: `DEMO-${w.id}` },
    });
    log(`  concluído pelo admin`);
  }
  return w;
}

async function ensureReview(client, contract, rating, comment) {
  const detail = await call('GET', `/contracts/${contract.id}`, { token: client.token });
  if (detail.status !== 'completed') return;
  if (detail.review) return log(`avaliação #${contract.id} já existe (${detail.review.rating}★)`);
  await call('POST', '/reviews', {
    token: client.token,
    body: { contractId: contract.id, rating, comment },
  });
  log(`avaliação #${contract.id} ${'★'.repeat(rating)} "${comment.slice(0, 40)}…"`);
}

/** Freelancer responde (uma vez) à avaliação recebida. */
async function ensureResponse(freelancer, contract, response) {
  const detail = await call('GET', `/contracts/${contract.id}`, { token: freelancer.token });
  if (!detail.review || detail.review.response) return;
  await call('POST', `/reviews/${detail.review.id}/response`, {
    token: freelancer.token,
    body: { response },
  });
  log(`resposta #${contract.id} "${response.slice(0, 40)}…"`);
}

/** Favorita um serviço (idempotente). */
/** Cliente abre uma disputa (idempotente) numa contratação entregue — fica na fila do admin. */
async function ensureDispute(client, contract, reason, description) {
  const mine = await call('GET', '/disputes', { token: client.token });
  if (mine.some((d) => d.contractId === contract.id)) return;
  const detail = await call('GET', `/contracts/${contract.id}`, { token: client.token });
  if (!['accepted', 'in_progress', 'delivered', 'revision_requested'].includes(detail.status))
    return;
  await call('POST', '/disputes', {
    token: client.token,
    body: { contractId: contract.id, reason, description },
  });
  log(`disputa  #${contract.id} (${reason})`);
}

async function ensureFavorite(user, service) {
  const mine = await call('GET', '/favorites', { token: user.token });
  if (mine.some((f) => f.targetType === 'service' && f.targetId === service.id)) return;
  await call('POST', '/favorites', {
    token: user.token,
    body: { targetType: 'service', targetId: service.id },
  });
  log(`favorito ${service.title}`);
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
    // Torna: quem recebe o serviço mais valioso paga a diferença (reservada da carteira).
    if (offered.price < requested.price) await ensureBalance(proposer, requested.price - offered.price);
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
    if (offered.price > requested.price) await ensureBalance(receiver, offered.price - requested.price);
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
  users.admin = await ensureAccount(ADMIN_EMAIL, 'client');
  for (const u of Object.values(users)) await ensureVerified(u, users.admin);

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

  step('Carteira da cliente (depósito PIX no gateway simulado)');
  await ensureBalance(ana, 6000);

  step('Contratações (todos os estados do escrow)');
  const landing = await ensureContract(ana, users.bruno, svc['Landing page em React'], {
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
  const ajustes = await ensureContract(ana, users.bruno, svc['Ajustes e correções no site'], {
    title: 'Ajustes e correções no site',
    price: 400,
    to: 'completed',
  });
  const identidade = await ensureContract(
    ana,
    users.marina,
    svc['Identidade visual (logo + guia)'],
    {
      title: 'Identidade visual (logo + guia)',
      price: 800,
      to: 'completed',
    },
  );
  await ensureContract(ana, users.marina, svc['Posts para redes sociais (pacote 12)'], {
    title: 'Posts para redes sociais (pacote 12)',
    price: 480,
    to: 'delivered',
  });
  const ensaio = await ensureContract(ana, users.carla, svc['Ensaio de produto (20 fotos)'], {
    title: 'Ensaio de produto (20 fotos)',
    price: 650,
    to: 'completed',
  });
  await ensureContract(ana, users.carla, svc['Ensaio de produto (20 fotos)'], {
    title: 'Fotos extras do cardápio',
    price: 320,
    to: 'revision',
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
  const eletrica = await ensureContract(ana, users.felipe, svc['Instalação elétrica (visita)'], {
    title: 'Revisão elétrica rápida (em créditos)',
    price: 60,
    paymentMode: 'credits',
    to: 'completed',
  });

  step('Avaliações (alimentam o Escambo Score)');
  await ensureReview(
    ana,
    landing,
    5,
    'Entrega impecável, antes do prazo e com código limpo. Recomendo!',
  );
  await ensureReview(ana, ajustes, 5, 'Rápido e preciso. Resolveu tudo em um dia.');
  await ensureReview(
    ana,
    identidade,
    4,
    'Identidade linda e bem documentada; as revisões demoraram um pouco.',
  );
  await ensureReview(ana, ensaio, 5, 'Fotos incríveis, valorizaram muito o produto.');
  await ensureReview(ana, eletrica, 5, 'Chegou no horário, resolveu na hora e explicou tudo.');
  await ensureResponse(users.bruno, landing, 'Obrigado, Ana! Foi um prazer trabalhar com você.');

  step('Impulsionamento (pago em créditos Escambo)');
  await ensureBoost(users.bruno, svc['Landing page em React']);

  step('Disputa (fila de mediação do admin)');
  const vinheta = await ensureContract(ana, users.rafael, svc['Motion graphics 15s'], {
    title: 'Vinheta animada 5s',
    price: 300,
    to: 'delivered',
  });
  await ensureDispute(
    ana,
    vinheta,
    'quality',
    'A vinheta veio com a logo antiga e sem o áudio combinado. Pedi ajuste e não tive retorno.',
  );

  step('Saques (fila do admin)');
  await ensureWithdrawal(users.marina, users.admin, 200, 'marina@escambo.demo', { complete: true });
  await ensureWithdrawal(users.bruno, users.admin, 300, '47 99999-0001');

  step('Favoritos da cliente');
  await ensureFavorite(ana, svc['Landing page em React']);
  await ensureFavorite(ana, svc['Ensaio de produto (20 fotos)']);

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
  console.log(`  admin       ${ADMIN_EMAIL}`);
  for (const f of FREELANCERS)
    console.log(`  freelancer  ${f.email.padEnd(24)} ${f.profile.fullName}`);
}

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
