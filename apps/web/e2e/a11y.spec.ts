import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { audit } from './a11y.helpers';
import {
  completeContract,
  createAdmin,
  createService,
  createUser,
  deliveredContract,
  latestEmail,
  linkIn,
  openAs,
  openLanding,
  pngFixture,
  settled,
  topUp,
  uploadImage,
  type TestUser,
} from './helpers';

/**
 * Acessibilidade automatizada (axe-core, regras WCAG 2.0/2.1 A e AA) em todas as telas do app,
 * públicas e autenticadas, com os estados que mais mudam a marcação: diálogos abertos, filtros
 * aplicados, listas com dados (entrega com arquivo, troca, chamado de suporte, denúncia) e os
 * links que chegam por e-mail. Qualquer violação WCAG reprova, de qualquer impacto (ver
 * a11y.helpers.ts e docs/acessibilidade.md); cada teste junta as telas e falha uma vez só,
 * listando cada violação com os elementos afetados.
 *
 * Roda nos projetos desktop (1440 px) e mobile (Pixel 7), que têm navegações diferentes.
 */

const h = (t: string) => ({ Authorization: `Bearer ${t}` });

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
);

/** Junta os problemas de várias telas e falha uma vez só, no fim. */
function collector(): {
  check: (page: Page, name: string) => Promise<void>;
  done: () => void;
} {
  const problems: string[] = [];
  return {
    check: async (page, name) => {
      problems.push(...(await audit(page, name)));
    },
    done: () => expect(problems.join('\n')).toBe(''),
  };
}

/** Lê o token do último e-mail do modelo dado, com uma conta admin. */
async function tokenFrom(
  request: APIRequestContext,
  admin: TestUser,
  user: TestUser,
  template: 'verify_email' | 'password_reset' | 'email_change',
): Promise<string> {
  const mail = await latestEmail(request, admin, user.id, template);
  const link = new URL(linkIn(mail.text));
  return `${link.pathname}${link.search}`;
}

test('páginas públicas (início, login, cadastro, senha, e-mail, termos, privacidade e 404)', async ({
  page,
}) => {
  const { check, done } = collector();

  // Página inicial sem sessão (landing), e de novo com as dúvidas abertas.
  await openLanding(page);
  await check(page, 'página inicial');
  await page
    .locator('details')
    .evaluateAll((all) => all.forEach((d) => ((d as HTMLDetailsElement).open = true)));
  await check(page, 'página inicial com as dúvidas abertas');

  // Cadastro pelo endereço, com o perfil escolhido na página inicial.
  await page.goto('/cadastro?perfil=freelancer');
  await expect(page.getByRole('heading', { name: 'Crie sua conta' })).toBeVisible();
  await expect(page.getByLabel('Eu sou')).toHaveValue('freelancer');
  await check(page, 'cadastro pelo endereço');

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Bem-vindo de volta' })).toBeVisible();
  await check(page, 'login');
  // Erro de login: a mensagem aparece e é anunciada.
  await page.getByLabel('E-mail').fill('ninguem@escambo.test');
  await page.getByLabel('Senha').fill('senha-errada-123');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await check(page, 'login com erro');
  await page.getByRole('button', { name: 'Crie sua conta' }).click();
  await expect(page.getByRole('heading', { name: 'Crie sua conta' })).toBeVisible();
  await check(page, 'cadastro');

  await page.goto('/esqueci-senha');
  await expect(page.getByRole('heading', { name: 'Esqueci minha senha' })).toBeVisible();
  await check(page, 'esqueci a senha');
  await page.getByLabel('E-mail').fill('ninguem@escambo.test');
  await page.getByRole('button', { name: 'Enviar link' }).click();
  await expect(page.getByTestId('forgot-sent')).toBeVisible();
  await check(page, 'esqueci a senha: enviado');

  for (const [path, name] of [
    ['/redefinir-senha', 'redefinir senha sem token'],
    ['/redefinir-senha?token=invalido', 'redefinir senha'],
    ['/verificar-email?token=invalido', 'confirmar e-mail com link inválido'],
    ['/confirmar-novo-email?token=invalido', 'confirmar novo e-mail'],
    ['/termos', 'termos de uso'],
    ['/privacidade', 'política de privacidade'],
    ['/endereco-que-nao-existe', '404'],
  ] as const) {
    await page.goto(path);
    await expect(page.locator('h1, h2').first()).toBeVisible();
    await expect(page.getByRole('status', { name: 'Carregando…' })).toHaveCount(0);
    await check(page, name);
  }
  done();
});

test('links que chegam por e-mail: confirmar e-mail, redefinir senha e confirmar novo e-mail', async ({
  page,
  request,
}) => {
  const { check, done } = collector();
  const admin = await createAdmin(request);
  // O link de confirmação só vale para quem ainda não confirmou (as contas de teste já nascem
  // confirmadas, RF-006).
  const user = await createUser(request, 'client', { verified: false });

  await page.goto(await tokenFrom(request, admin, user, 'verify_email'));
  await expect(page.getByTestId('verify-ok')).toBeVisible();
  await check(page, 'e-mail confirmado');

  const forgot = await request.post('/api/auth/forgot-password', { data: { email: user.email } });
  expect(forgot.ok(), await forgot.text()).toBeTruthy();
  await page.goto(await tokenFrom(request, admin, user, 'password_reset'));
  await expect(page.getByLabel('Nova senha', { exact: true })).toBeVisible();
  await check(page, 'redefinir senha com link válido');
  // Senhas diferentes: o erro aparece ligado ao formulário.
  await page.getByLabel('Nova senha', { exact: true }).fill('NovaSenha@456');
  await page.getByLabel('Confirmar nova senha').fill('OutraSenha@789');
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await check(page, 'redefinir senha com erro');

  const other = await createUser(request, 'freelancer');
  const changed = await request.post('/api/auth/change-email', {
    headers: h(other.token),
    data: {
      currentPassword: 'Escambo@123',
      newEmail: `novo-${other.id}-${Date.now()}@escambo.test`,
    },
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  const link = await tokenFrom(request, admin, other, 'email_change');
  await openAs(page, other, link);
  await expect(page.getByRole('button', { name: 'Confirmar novo e-mail' })).toBeVisible();
  await check(page, 'confirmar novo e-mail (logado)');
  await page.getByRole('button', { name: 'Confirmar novo e-mail' }).click();
  await expect(page.getByTestId('email-change-ok')).toBeVisible();
  await check(page, 'novo e-mail confirmado');
  done();
});

test('recorte da foto de perfil', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  await openAs(page, freelancer, '/perfil');
  await settled(page);
  await page
    .getByTestId('avatar-upload')
    .first()
    .setInputFiles({ name: 'eu.png', mimeType: 'image/png', buffer: pngFixture(120, 80) });
  await expect(page.getByRole('dialog', { name: 'Ajustar foto' })).toBeVisible();
  const problems = await audit(page, 'recorte da foto');
  expect(problems.join('\n')).toBe('');
});

test('galeria do portfólio', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const headers = h(freelancer.token);
  const image = await uploadImage(request, freelancer, pngFixture(120 + (Date.now() % 300), 80));
  const added = await request.post('/api/profiles/portfolio', {
    headers,
    data: {
      title: 'Trabalho da auditoria',
      description: 'Descrição do trabalho.',
      imageUrl: image,
      externalUrl: 'https://exemplo.com/trabalho',
    },
  });
  expect(added.ok(), await added.text()).toBeTruthy();
  const { ulid } = (await (await request.get('/api/auth/me', { headers })).json()) as {
    ulid: string;
  };
  const viewer = await createUser(request, 'client');
  await openAs(page, viewer, `/freelancers/${ulid}`);
  await settled(page);
  await page.getByRole('button', { name: 'Ampliar Trabalho da auditoria' }).click();
  await expect(page.getByRole('dialog', { name: 'Trabalho da auditoria' })).toBeVisible();
  const problems = await audit(page, 'galeria do portfólio');
  expect(problems.join('\n')).toBe('');
});

test('telas do menu (freelancer com perfil, missões e notificações) e 404 dentro do app', async ({
  page,
  request,
}) => {
  const { check, done } = collector();
  const user = await createUser(request, 'freelancer');
  const service = await createService(request, user, 180);
  const client = await createUser(request, 'client');
  // Uma proposta recebida: gera notificação e a contratação no início.
  await topUp(request, client, 200);
  const proposal = await request.post('/api/contracts', {
    headers: h(client.token),
    data: {
      freelancerId: user.id,
      serviceId: service.id,
      title: service.title,
      description: 'Proposta criada para a auditoria de acessibilidade.',
      price: 180,
    },
  });
  expect(proposal.ok(), await proposal.text()).toBeTruthy();

  await openAs(page, user, '/');
  await settled(page);
  await expect(page.getByRole('heading', { name: 'Missões' })).toBeVisible();
  await check(page, 'início com missões');
  for (const [path, name] of [
    ['/servicos', 'serviços'],
    [`/servicos/${service.id}`, 'detalhe do serviço (dono)'],
    ['/trocas', 'trocas'],
    ['/ranking', 'ranking'],
    ['/carteira', 'carteira'],
    ['/notificacoes', 'notificações'],
    ['/perfil', 'perfil'],
    ['/suporte', 'suporte'],
    ['/caminho/que/nao/existe', '404 autenticado'],
  ] as const) {
    await page.goto(path);
    await settled(page);
    await check(page, name);
  }
  done();
});

test('serviço de outra pessoa e o modal de contratação', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 220);
  const client = await createUser(request, 'client');
  await topUp(request, client, 300);
  await openAs(page, client, `/servicos/${service.id}`);
  await settled(page);
  const { check, done } = collector();
  await check(page, 'detalhe do serviço');
  await page.getByRole('button', { name: 'Contratar' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await check(page, 'modal de contratação');
  done();
});

test('serviço com pacotes: abas, comparação e o modal com o nível (RF-086)', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const tier = (t: 'basic' | 'standard' | 'premium', price: number, features: string[]) => ({
    tier: t,
    name: `Pacote ${t}`,
    description: t === 'basic' ? 'Um conceito de logo.' : null,
    price,
    deliveryDays: t === 'premium' ? 10 : 3,
    revisions: 2,
    features,
  });
  const service = await createService(request, freelancer, 0, 0, {
    packages: [
      tier('basic', 150, ['Logo']),
      tier('standard', 320, ['Logo', 'Paleta de cores']),
      tier('premium', 649.9, ['Logo', 'Paleta de cores', 'Manual da marca']),
    ],
  });
  const client = await createUser(request, 'client');
  await topUp(request, client, 700);
  await openAs(page, client, `/servicos/${service.id}`);
  await settled(page);
  const { check, done } = collector();
  await check(page, 'detalhe com pacotes');
  await page.getByRole('tab', { name: 'Premium' }).click();
  await check(page, 'aba Premium');
  await page.getByRole('button', { name: /^Continuar/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await check(page, 'modal de contratação do pacote');
  done();
});

test('ranking com filtro de categoria e "perto de mim"', async ({ page, context, request }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -26.3045, longitude: -48.8487 });
  const user = await createUser(request, 'freelancer');
  await openAs(page, user, '/ranking');
  await settled(page);
  const { check, done } = collector();
  await page.getByLabel('Categoria do ranking').selectOption({ index: 1 });
  await settled(page);
  await check(page, 'ranking por categoria');
  await page.getByRole('button', { name: 'Perto de mim' }).click();
  await expect(page.getByRole('button', { name: 'Perto de mim: ativo' })).toBeVisible();
  await settled(page);
  await check(page, 'ranking perto de mim');
  done();
});

test('carteira com ganhos, extrato em créditos e depósito PIX', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 200);
  const client = await createUser(request, 'client');
  await completeContract(request, client, freelancer, service);
  const { check, done } = collector();

  await openAs(page, freelancer, '/carteira');
  await settled(page);
  const earnings = page.getByTestId('earnings');
  await expect(earnings.getByRole('tablist', { name: 'Período dos ganhos' })).toBeVisible();
  await check(page, 'carteira com ganhos');
  await earnings.getByRole('tab').last().click();
  await settled(page);
  await page.getByRole('tab', { name: 'Créditos' }).click();
  await settled(page);
  await check(page, 'carteira: ganhos por outro período e extrato em créditos');

  await openAs(page, client, '/carteira');
  await settled(page);
  await page.getByRole('button', { name: 'Depositar' }).click();
  const modal = page.getByRole('dialog');
  await check(page, 'depósito: valor');
  await modal.getByRole('button', { name: /Gerar cobrança PIX/ }).click();
  await expect(modal.getByTestId('pix-code')).toBeVisible();
  await check(page, 'depósito: cobrança');
  done();
});

test('trocas com proposta recebida e enviada', async ({ page, request }) => {
  const owner = await createUser(request, 'freelancer');
  const wanted = await createService(request, owner, 300);
  const me = await createUser(request, 'freelancer');
  const mine = await createService(request, me, 400);
  const created = await request.post('/api/barters', {
    headers: h(me.token),
    data: {
      receiverId: owner.id,
      offeredServiceId: mine.id,
      requestedServiceId: wanted.id,
      estimatedValueOffered: 400,
      estimatedValueRequested: 300,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { id } = (await created.json()) as { id: number };
  const { check, done } = collector();

  await openAs(page, owner, '/trocas');
  await settled(page);
  await expect(page.getByTestId(`barter-${id}`)).toBeVisible();
  await check(page, 'trocas: proposta recebida');
  await openAs(page, me, '/trocas');
  await settled(page);
  await expect(page.getByTestId(`barter-${id}`)).toBeVisible();
  await check(page, 'trocas: proposta enviada');
  done();
});

test('sala com entrega com arquivo, anexos no chat e o formulário de entrega', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const client = await createUser(request, 'client');
  const service = await createService(request, freelancer, 250);
  // Uma contratação em aberto por par cliente-freelancer: a segunda é com outra pessoa.
  const other = await createUser(request, 'freelancer');
  const otherService = await createService(request, other, 250);
  await topUp(request, client, 500);
  const create = async (who: TestUser, svc: { id: number; title: string }): Promise<number> => {
    const res = await request.post('/api/contracts', {
      headers: h(client.token),
      data: {
        freelancerId: who.id,
        serviceId: svc.id,
        title: svc.title,
        description: 'Contratação da auditoria de acessibilidade da Sala.',
        price: 250,
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const { id } = (await res.json()) as { id: number };
    const accepted = await request.post(`/api/contracts/${id}/accept`, {
      headers: h(who.token),
    });
    expect(accepted.ok(), await accepted.text()).toBeTruthy();
    return id;
  };
  const delivered = await create(freelancer, service);
  const delivery = await request.post(`/api/contracts/${delivered}/deliver`, {
    headers: h(freelancer.token),
    multipart: {
      message: 'Manual da marca em PDF',
      attachments: { name: 'manual.pdf', mimeType: 'application/pdf', buffer: PDF },
    },
  });
  expect(delivery.ok(), await delivery.text()).toBeTruthy();
  for (const [who, file, mimeType, buffer] of [
    [freelancer, 'rascunho.png', 'image/png', pngFixture()],
    [client, 'briefing.pdf', 'application/pdf', PDF],
  ] as const) {
    const sent = await request.post(`/api/messaging/contracts/${delivered}/attachments`, {
      headers: h(who.token),
      multipart: { file: { name: file, mimeType, buffer }, content: `Anexo ${file}` },
    });
    expect(sent.ok(), await sent.text()).toBeTruthy();
  }
  const { check, done } = collector();

  await openAs(page, client, `/contratos/${delivered}`);
  await settled(page);
  await expect(page.getByTestId('deliveries')).toContainText('manual.pdf');
  await expect(page.getByRole('img', { name: 'rascunho.png' })).toBeVisible();
  await check(page, 'sala: entrega com arquivo e anexos');
  await page.getByRole('button', { name: 'Abrir imagem rascunho.png' }).click();
  await expect(page.getByRole('dialog', { name: 'rascunho.png' })).toBeVisible();
  await check(page, 'sala: imagem do chat ampliada');
  await page.keyboard.press('Escape');

  const inProgress = await create(other, otherService);
  await openAs(page, other, `/contratos/${inProgress}`);
  await settled(page);
  await check(page, 'sala: em andamento (freelancer)');
  await page.getByRole('button', { name: 'Registrar entrega' }).click();
  const form = page.getByRole('dialog', { name: 'Registrar entrega' });
  await form
    .getByTestId('deliver-file-input')
    .setInputFiles({ name: 'manual.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(form.getByTestId('attachment-pending')).toContainText('manual.pdf');
  await check(page, 'sala: formulário de entrega com arquivo');
  done();
});

test('sala do contrato concluído (linha do tempo, chat e formulário de avaliação)', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 200);
  const client = await createUser(request, 'client');
  const contractId = await completeContract(request, client, freelancer, service);
  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByRole('radiogroup', { name: 'Nota' })).toBeVisible();
  expect((await audit(page, 'sala do contrato')).join('\n')).toBe('');
});

test('suporte com chamado aberto, conversa e o formulário de novo chamado', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  const res = await request.post('/api/support/tickets', {
    headers: h(user.token),
    data: {
      category: 'other',
      subject: `Dúvida ${user.id}`,
      description: 'Quero confirmar uma informação sobre a plataforma.',
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const { check, done } = collector();
  await openAs(page, user, '/suporte');
  await settled(page);
  await page.getByRole('button', { name: new RegExp(`Dúvida ${user.id}`) }).click();
  await expect(page.getByRole('region', { name: 'Detalhes do chamado' })).toBeVisible();
  await settled(page);
  await check(page, 'suporte: conversa do chamado');
  await page.getByRole('button', { name: 'Abrir chamado' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await check(page, 'suporte: novo chamado');
  done();
});

test('painel admin com relatórios, denúncia, chamado e a conversa do suporte', async ({
  page,
  request,
}) => {
  const client = await createUser(request, 'client');
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer);
  const contractId = await deliveredContract(request, client, freelancer, service);
  const sent = await request.post(`/api/messaging/contracts/${contractId}`, {
    headers: h(freelancer.token),
    data: { content: `Me paga por fora no pix ${Date.now().toString(36)}` },
  });
  expect(sent.ok(), await sent.text()).toBeTruthy();
  const reported = await request.post('/api/reports', {
    headers: h(client.token),
    data: {
      targetType: 'message',
      targetId: ((await sent.json()) as { id: number }).id,
      reason: 'off_platform',
    },
  });
  expect(reported.ok(), await reported.text()).toBeTruthy();
  const ticket = await request.post('/api/support/tickets', {
    headers: h(client.token),
    data: {
      category: 'other',
      subject: `Chamado ${client.id}`,
      description: 'Preciso de ajuda com a minha conta.',
    },
  });
  expect(ticket.ok(), await ticket.text()).toBeTruthy();
  const { id: ticketId } = (await ticket.json()) as { id: number };

  const admin = await createAdmin(request);
  const { check, done } = collector();
  await openAs(page, admin, '/admin');
  await settled(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Administração' })).toBeVisible();
  await expect(page.getByTestId('usage')).toBeVisible();
  await expect(page.getByTestId('reports-card')).toContainText('por fora');
  await check(page, 'admin');
  await page.goto(`/admin?ticket=${ticketId}#suporte`);
  await settled(page);
  await expect(page.getByRole('region', { name: 'Detalhes do chamado' })).toBeVisible();
  await check(page, 'admin: conversa do chamado');
  done();
});
