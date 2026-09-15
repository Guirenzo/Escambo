import { expect, test } from '@playwright/test';
import { createUser, openAs, pngFixture, settled, uploadImage } from './helpers';

/**
 * Galeria do portfólio (ADR 40): ampliar pelo cartão, navegar pelo teclado em círculo com o link
 * acompanhando, fechar com Esc devolvendo o foco e abrir direto pelo link ?trabalho=ID. Desktop e
 * mobile.
 */

test('galeria do portfólio: amplia, navega pelo teclado, devolve o foco e abre pelo link', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const headers = { Authorization: `Bearer ${freelancer.token}` };
  const tag = Date.now().toString(36);
  const logo = `Logo ${tag}`;
  const menu = `Cardápio ${tag}`;
  const site = `Site ${tag}`;
  const logoImage = await uploadImage(
    request,
    freelancer,
    pngFixture(640, 400 + (Date.now() % 200)),
  );
  const menuImage = await uploadImage(request, freelancer, pngFixture(400, 640));
  for (const data of [
    {
      title: logo,
      description: 'Identidade visual da padaria.',
      imageUrl: logoImage,
      externalUrl: 'https://exemplo.com/logo',
    },
    { title: menu, imageUrl: menuImage },
    { title: site, externalUrl: 'https://exemplo.com/site' },
  ]) {
    const res = await request.post('/api/profiles/portfolio', { headers, data });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const list = (await (await request.get('/api/profiles/portfolio', { headers })).json()) as {
    id: number;
    title: string;
  }[];
  const menuId = list.find((i) => i.title === menu)!.id;
  const { ulid } = (await (await request.get('/api/auth/me', { headers })).json()) as {
    ulid: string;
  };
  const profile = `/freelancers/${ulid}`;

  const client = await createUser(request, 'client');
  await openAs(page, client, profile);
  await settled(page);
  // Trabalho só com link não tem o que ampliar.
  await expect(page.getByRole('button', { name: `Ampliar ${site}` })).toHaveCount(0);

  const openLogo = page.getByRole('button', { name: `Ampliar ${logo}` });
  await openLogo.click();
  const logoDialog = page.getByRole('dialog', { name: logo });
  await expect(logoDialog).toBeVisible();
  await expect(logoDialog.getByText('1 de 2')).toBeVisible();
  await expect(logoDialog.getByText('Identidade visual da padaria.')).toBeVisible();
  const big = logoDialog.locator('img.gallery-image');
  await expect(big).toHaveAttribute('srcset', /\?w=960 960w/);
  await expect
    .poll(() => big.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(page).toHaveURL(/\?trabalho=\d+$/);

  // As setas navegam em círculo, e o link acompanha o trabalho aberto.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: menu })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('2 de 2')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`trabalho=${menuId}$`));
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: logo })).toBeVisible();

  // Zoom (ADR 43): botão, teclado e duplo clique; ampliada, a seta desloca em vez de trocar.
  const canvas = logoDialog.locator('.gallery-canvas');
  await logoDialog.getByRole('button', { name: 'Ampliar imagem' }).click();
  await expect(
    logoDialog.getByRole('button', { name: 'Voltar ao tamanho inteiro (150%)' }),
  ).toBeVisible();
  await page.keyboard.press('+');
  await expect(canvas).toHaveAttribute('style', /scale\(2\.25\)/);
  await page.keyboard.press('ArrowRight');
  await expect(logoDialog.getByText('1 de 2')).toBeVisible();
  await page.keyboard.press('0');
  await expect(canvas).toHaveAttribute('style', /scale\(1\)/);
  await logoDialog.locator('img.gallery-image').dblclick();
  await expect(canvas).toHaveAttribute('style', /scale\(2\.5\)/);
  await logoDialog.getByRole('button', { name: /Voltar ao tamanho inteiro/ }).click();
  await expect(canvas).toHaveAttribute('style', /scale\(1\)/);

  // Esc fecha, tira o trabalho da URL e devolve o foco ao cartão.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/trabalho=/);
  await expect(openLogo).toBeFocused();

  // O link direto abre no trabalho certo; fechar limpa a URL.
  await openAs(page, client, `${profile}?trabalho=${menuId}`);
  await expect(page.getByRole('dialog', { name: menu })).toBeVisible();
  await page.getByRole('button', { name: 'Fechar galeria' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${profile}$`));
});

test('ordem do portfólio: o freelancer move pelas setas, a ordem fica e sai no perfil público', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const headers = { Authorization: `Bearer ${freelancer.token}` };
  const tag = Date.now().toString(36);
  const titles = [`Primeiro ${tag}`, `Segundo ${tag}`, `Terceiro ${tag}`];
  for (const title of titles) {
    const res = await request.post('/api/profiles/portfolio', {
      headers,
      data: { title, externalUrl: `https://exemplo.com/${tag}` },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const [first, second, third] = titles as [string, string, string];

  await openAs(page, freelancer, '/perfil');
  await settled(page);
  const card = page.getByTestId('portfolio-card');
  const rows = card.locator('[data-testid^="portfolio-row-"] strong');
  await expect(rows).toHaveText([first, second, third]);
  await expect(card.getByRole('button', { name: `Mover ${first} para cima` })).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  // O terceiro sobe duas vezes: o foco fica no mesmo botão e a posição é anunciada.
  const up = () => card.getByRole('button', { name: `Mover ${third} para cima` });
  await up().click();
  await expect(rows).toHaveText([first, third, second]);
  await expect(up()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText([third, first, second]);
  await expect(up()).toBeFocused();
  await expect(up()).toHaveAttribute('aria-disabled', 'true');
  await expect(card.locator('.portfolio-announce')).toHaveText(`${third} agora é o 1º de 3.`);

  // Fica depois de recarregar e sai igual no perfil público.
  await expect
    .poll(async () =>
      (
        (await (await request.get('/api/profiles/portfolio', { headers })).json()) as {
          title: string;
        }[]
      ).map((i) => i.title),
    )
    .toEqual([third, first, second]);
  await page.reload();
  await settled(page);
  await expect(rows).toHaveText([third, first, second]);
  const { ulid } = (await (await request.get('/api/auth/me', { headers })).json()) as {
    ulid: string;
  };
  const client = await createUser(request, 'client');
  await openAs(page, client, `/freelancers/${ulid}`);
  await settled(page);
  await expect(page.locator('.portfolio-item')).toContainText([third, first, second]);
});
