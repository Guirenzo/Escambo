import { expect, test, type Page } from '@playwright/test';
import { audit } from './a11y.helpers';
import {
  createAdmin,
  createCompany,
  createService,
  createUser,
  openAs,
  PASSWORD,
  settled,
  topUp,
  uniqueCnpj,
  uniqueCpf,
  verifyCpf,
  verifyEmail,
} from './helpers';

/**
 * Documentos (1.53.0): o CPF do freelancer (RF-020), que o saque passa a pedir, e a conta de
 * empresa (RF-018), do cadastro à página pública, com o selo onde quem contrata aparece. Cada tela
 * nova passa também pelo axe. Roda em desktop e mobile.
 */

const cpfMask = (cpf: string): string =>
  `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
const cnpjMask = (c: string): string =>
  `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;

/** Junta as violações do axe e falha uma vez só, no fim. */
function collector(): { check: (page: Page, name: string) => Promise<void>; done: () => void } {
  const problems: string[] = [];
  return {
    check: async (page, name) => {
      problems.push(...(await audit(page, name)));
    },
    done: () => expect(problems.join('\n')).toBe(''),
  };
}

test('freelancer: a Carteira pede o CPF, o Perfil valida uma vez e mostra só mascarado, e o saque passa', async ({
  page,
  request,
}) => {
  const { check, done } = collector();
  const freelancer = await createUser(request, 'freelancer');
  const admin = await createAdmin(request);
  await verifyEmail(request, freelancer, admin);
  await topUp(request, freelancer, 150);

  await openAs(page, freelancer, '/carteira');
  await settled(page);
  const locked = page.getByTestId('withdraw-cpf');
  await expect(locked).toContainText('Valide seu CPF para sacar');
  await expect(page.locator('form', { hasText: 'Solicitar saque' })).toHaveCount(0);
  await check(page, 'carteira pedindo o CPF');

  await locked.getByRole('link', { name: 'Informar o CPF' }).click();
  await expect(page).toHaveURL(/\/perfil#dados-recebimento$/);
  const card = page.getByTestId('cpf-card');
  await expect(card.getByRole('heading', { name: 'Dados para receber' })).toBeVisible();
  await expect(card).toContainText('Não é uma consulta à Receita Federal.');

  // Dígito errado avisa no campo, sem ir à API.
  const cpf = uniqueCpf();
  const wrong = `${cpf.slice(0, 10)}${(Number(cpf[10]) + 1) % 10}`;
  const field = card.getByLabel('CPF', { exact: true });
  await field.fill(wrong);
  await expect(field).toHaveValue(cpfMask(wrong));
  await card.getByLabel('Data de nascimento').fill('1990-05-17');
  await card.getByRole('button', { name: 'Validar CPF' }).click();
  await expect(card.getByRole('alert')).toHaveText('CPF inválido: confira os 11 dígitos.');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await check(page, 'perfil com o CPF recusado');

  // Menor de idade: a recusa vem da API, com a regra.
  await field.fill(cpf);
  await card.getByLabel('Data de nascimento').fill('2015-01-01');
  await card.getByRole('button', { name: 'Validar CPF' }).click();
  await expect(card.getByRole('alert')).toContainText('18 anos ou mais');

  await card.getByLabel('Data de nascimento').fill('1990-05-17');
  await card.getByRole('button', { name: 'Validar CPF' }).click();
  const done1 = page.getByTestId('cpf-validado');
  await expect(done1).toContainText(`CPF validado: ***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`);
  await expect(done1).toContainText('17/05/1990');
  await expect(card).not.toContainText(cpf.slice(0, 3) + '.');
  await expect(card.getByLabel('CPF', { exact: true })).toHaveCount(0);
  await check(page, 'perfil com o CPF validado');

  // O saque passa.
  await page.goto('/carteira');
  await settled(page);
  await expect(page.getByTestId('withdraw-cpf')).toHaveCount(0);
  const form = page.locator('form', { hasText: 'Solicitar saque' });
  await form.getByLabel(/Valor \(R\$\)/).fill('50');
  await form.getByLabel('Chave PIX').fill(`pix-${freelancer.id}@escambo.test`);
  await form.getByRole('button', { name: /Sacar/ }).click();
  await expect(page.locator('.toast', { hasText: 'Saque solicitado' })).toBeVisible();
  done();
});

test('atendimento: o CPF aparece só mascarado e é apagado para correção, com o motivo', async ({
  page,
  request,
}) => {
  const { check, done } = collector();
  const freelancer = await createUser(request, 'freelancer');
  const admin = await createAdmin(request);
  const cpf = await verifyCpf(request, freelancer);

  await openAs(page, admin, '/admin');
  await settled(page);
  const support = page.locator('#atendimento-conta');
  await support.getByLabel('E-mail da conta').fill(freelancer.email);
  await support.getByRole('button', { name: 'Buscar' }).click();
  await expect(support.getByTestId('lookup-cpf')).toContainText(
    `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-** · validado`,
  );
  await expect(support).not.toContainText(cpf);
  await support.getByRole('button', { name: 'Apagar o CPF para correção' }).click();
  const dialog = page.getByRole('dialog', { name: 'Apagar o CPF para correção' });
  await dialog
    .getByLabel('Motivo (fica no registro do atendimento)')
    .fill('Titular digitou o CPF errado; documento conferido no chamado.');
  await check(page, 'atendimento apagando o CPF');
  await dialog.getByRole('button', { name: 'Apagar o CPF' }).click();
  await expect(page.locator('.toast', { hasText: 'CPF apagado' })).toBeVisible();
  await expect(support.getByTestId('lookup-cpf')).toContainText('Não informado');
  done();
});

test('empresa: cadastro com CNPJ alfanumérico, Perfil da empresa, página pública e o selo para o freelancer', async ({
  page,
  request,
}) => {
  const { check, done } = collector();

  // Cadastro pelo formulário: o CNPJ errado avisa no campo; o certo, em minúsculas e com máscara, passa.
  const cnpj = uniqueCnpj();
  const email = `e2e-empresa-${Date.now().toString(36)}@escambo.test`;
  await page.goto('/cadastro?perfil=empresa');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await expect(page.getByLabel('Eu sou')).toHaveValue('company');
  const group = page.getByRole('group', { name: 'Dados da empresa' });
  await group.getByLabel('Razão social').fill('Oficina Criativa Comunicação Ltda');
  await group.getByLabel('Nome fantasia').fill('Oficina Criativa');
  const wrong = `${cnpj.slice(0, 13)}${(Number(cnpj[13]) + 1) % 10}`;
  await group.getByLabel('CNPJ').fill(cnpjMask(wrong));
  await page.getByRole('checkbox', { name: /Li e aceito/ }).check();
  await page
    .locator('form.au-card')
    .getByRole('button', { name: 'Criar conta', exact: true })
    .last()
    .click();
  await expect(group.getByRole('alert')).toContainText('CNPJ inválido');
  await check(page, 'cadastro de empresa com o CNPJ recusado');
  await group.getByLabel('CNPJ').fill(cnpjMask(cnpj).toLowerCase());
  await page
    .locator('form.au-card')
    .getByRole('button', { name: 'Criar conta', exact: true })
    .last()
    .click();
  await expect(page).toHaveURL(/\/$/);
  await settled(page);

  // O Perfil da empresa: o nome fantasia no topo, o selo e os dados da empresa no lugar dos de cliente.
  await page.goto('/perfil');
  await settled(page);
  await expect(page.getByRole('heading', { level: 2, name: 'Oficina Criativa' })).toBeVisible();
  const companyCard = page.getByTestId('empresa-card');
  await expect(companyCard.getByLabel('CNPJ')).toHaveValue(cnpjMask(cnpj));
  await expect(page.getByRole('button', { name: 'Salvar cliente' })).toHaveCount(0);
  await companyCard.getByLabel('Site').fill('https://oficinacriativa.com.br');
  await companyCard
    .getByLabel('Descrição curta (até 280 caracteres)')
    .fill('Comunicação para pequenos negócios de Joinville.');
  await companyCard.getByLabel('Cidade').fill('Joinville');
  await companyCard.getByLabel('Estado (UF)').fill('sc');
  await companyCard.getByRole('button', { name: 'Salvar empresa' }).click();
  await expect(page.locator('.toast', { hasText: 'Dados da empresa salvos!' })).toBeVisible();
  await check(page, 'perfil da empresa');

  await page.getByRole('link', { name: /Ver a página da empresa/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Oficina Criativa' })).toBeVisible();
  await expect(page.getByTestId('company-cnpj')).toHaveText(cnpjMask(cnpj));
  await expect(page.getByRole('link', { name: 'oficinacriativa.com.br' })).toHaveAttribute(
    'href',
    'https://oficinacriativa.com.br/',
  );
  await check(page, 'página pública da empresa');

  // A empresa contrata; o freelancer vê o nome fantasia e o selo no Início e na Sala.
  const company = await createCompany(request, { tradeName: 'Padaria do Bairro' });
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 200);
  await topUp(request, company, 200);
  const created = await request.post('/api/contracts', {
    headers: { Authorization: `Bearer ${company.token}` },
    data: {
      freelancerId: freelancer.id,
      serviceId: service.id,
      title: service.title,
      description: 'Contratação feita por uma conta de empresa.',
      price: 200,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const contractId = ((await created.json()) as { id: number }).id;

  await openAs(page, freelancer, '/');
  await settled(page);
  const card = page.getByRole('article', { name: service.title });
  await expect(card.getByTestId('company-tag')).toContainText('Padaria do Bairro');
  await page.goto(`/contratos/${contractId}`);
  await settled(page);
  const tag = page.getByTestId('company-tag');
  await expect(tag).toContainText('Contratante: Padaria do Bairro Empresa');
  await check(page, 'sala com a empresa contratante');
  await tag.getByRole('link', { name: 'Padaria do Bairro' }).click();
  await expect(page).toHaveURL(new RegExp(`/empresas/${company.ulid}$`));
  await expect(page.getByTestId('company-cnpj')).toHaveText(cnpjMask(company.cnpj));
  done();
});
