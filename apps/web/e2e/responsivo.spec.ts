import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  createService,
  createUser,
  deliveredContract,
  openAs,
  openLanding,
  settled,
} from './helpers';

/**
 * RNF-026: as telas principais no piso de 320 px e em largura de tablet (768 px), além dos 1440 px
 * e do Pixel 7 do smoke. Em cada largura e em cada tela:
 *  - a página não rola na horizontal (document.documentElement.scrollWidth <= innerWidth); tabelas
 *    e grades largas rolam dentro do próprio container;
 *  - a navegação principal está inteira na tela (barra inferior até 720 px, trilho de ícones até
 *    1024 px), cada link com nome acessível e alvo de toque de pelo menos 24 px (WCAG 2.5.8). Na
 *    barra inferior ficam 4 áreas e o "Mais", que abre o resto numa folha, também inteira na tela.
 * E a página inicial pública e o cadastro: sem rolagem horizontal, com Entrar e Criar conta na tela
 * (as âncoras do topo só a partir de 48rem, sem menu escondido).
 *
 * Roda no projeto `desktop` (playwright.config): a largura vem do test.use de cada bloco.
 */

const WIDTHS = [
  { width: 320, height: 640, layout: 'barra inferior' },
  { width: 768, height: 1024, layout: 'trilho de ícones' },
] as const;

async function noHorizontalScroll(page: Page, where: string): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    scrollWidth,
    `${where}: a página rola ${scrollWidth - innerWidth}px na horizontal`,
  ).toBeLessThanOrEqual(innerWidth);
}

/** O alvo inteiro na tela, sem rolar para achar, e com pelo menos 24 px (WCAG 2.5.8). */
async function fullyInView(page: Page, target: Locator, label: string): Promise<void> {
  const viewport = page.viewportSize()!;
  await expect(target, label).toBeVisible();
  const box = await target.boundingBox();
  expect(box, `${label} sem caixa`).not.toBeNull();
  expect(box!.x, `${label} sai pela esquerda`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label} sai pela direita`).toBeLessThanOrEqual(
    viewport.width + 0.5,
  );
  expect(box!.y, `${label} sai por cima`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${label} sai por baixo`).toBeLessThanOrEqual(viewport.height + 0.5);
  expect(
    Math.min(box!.width, box!.height),
    `${label} tem alvo menor que 24 px`,
  ).toBeGreaterThanOrEqual(24);
}

async function navigationReachable(page: Page, where: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Principal' });
  await expect(nav, `${where}: navegação principal visível`).toBeVisible();
  const viewport = page.viewportSize();
  expect(viewport, 'o projeto define a largura da janela').not.toBeNull();
  const more = nav.getByRole('button', { name: 'Mais' });
  if (await more.isVisible()) {
    // Barra inferior: 4 áreas e o "Mais", todos com rótulo; o "Mais" abre o resto numa folha.
    const bar = nav.getByRole('link');
    expect(await bar.count(), `${where}: a barra tem 4 áreas`).toBe(4);
    for (let i = 0; i < 4; i++) {
      const link = bar.nth(i);
      await expect(link, `${where}: área ${i + 1} sem rótulo visível`).toHaveText(/\S/);
      await fullyInView(page, link, `${where}: ${await link.textContent()}`);
    }
    await fullyInView(page, more, `${where}: Mais`);
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    const all = nav.getByRole('link');
    const total = await all.count();
    expect(total, `${where}: com o "Mais" aberto, o menu inteiro`).toBeGreaterThanOrEqual(8);
    for (let i = 4; i < total; i++) {
      const link = all.nth(i);
      await fullyInView(page, link, `${where}: ${await link.textContent()} (no "Mais")`);
    }
    await page.keyboard.press('Escape');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    return;
  }
  const links = nav.getByRole('link');
  const count = await links.count();
  expect(count, `${where}: a navegação tem os links do menu`).toBeGreaterThanOrEqual(7);
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    // O texto do link some no trilho e na barra; o nome que o leitor de tela lê precisa continuar
    // dizendo para onde ele vai (o title, que é o rótulo do menu).
    const name = (await link.getAttribute('title')) ?? '';
    expect(name, `${where}: link ${i + 1} sem rótulo`).toMatch(/\S/);
    await expect(link, `${where}: ${name}`).toBeVisible();
    await expect(link, `${where}: ${name} sem o rótulo no nome acessível`).toHaveAccessibleName(
      new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    const box = await link.boundingBox();
    expect(box, `${where}: ${name} sem caixa`).not.toBeNull();
    // Inteiro na tela, sem rolar para achar.
    expect(box!.x, `${where}: ${name} sai pela esquerda`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${where}: ${name} sai pela direita`).toBeLessThanOrEqual(
      viewport!.width + 0.5,
    );
    expect(box!.y, `${where}: ${name} sai por cima`).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, `${where}: ${name} sai por baixo`).toBeLessThanOrEqual(
      viewport!.height + 0.5,
    );
    expect(
      Math.min(box!.width, box!.height),
      `${where}: ${name} tem alvo menor que 24 px`,
    ).toBeGreaterThanOrEqual(24);
  }
}

for (const { width, height, layout } of WIDTHS) {
  test.describe(`${width} px (${layout})`, () => {
    test.use({ viewport: { width, height } });

    test(`página inicial e cadastro a ${width} px: sem rolagem horizontal, entrada na tela`, async ({
      page,
    }) => {
      await openLanding(page);
      await noHorizontalScroll(page, `página inicial a ${width} px`);
      const banner = page.getByRole('banner');
      for (const name of ['Entrar', 'Criar conta']) {
        const link = banner.getByRole('link', { name, exact: true });
        await expect(link, `${name} no topo`).toBeInViewport({ ratio: 1 });
        const box = await link.boundingBox();
        expect(Math.min(box!.width, box!.height), `${name}: alvo`).toBeGreaterThanOrEqual(24);
      }
      const anchors = page.getByRole('navigation', { name: 'Seções da página' });
      if (width < 768) await expect(anchors).toBeHidden();
      else await expect(anchors.getByRole('link', { name: 'Dúvidas' })).toBeInViewport();
      // A âncora leva à seção, que para abaixo do cabeçalho grudado (e não escondida atrás dele).
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.getByRole('link', { name: 'Ver como funciona' }).click();
      await expect(page).toHaveURL(/#troca$/);
      const title = page.getByRole('heading', { level: 2, name: 'Como funciona uma troca' });
      await expect(title).toBeInViewport();
      const header = await banner.boundingBox();
      const target = await page.locator('#troca').boundingBox();
      expect(target!.y + 1, 'seção atrás do cabeçalho').toBeGreaterThanOrEqual(
        header!.y + header!.height - 1,
      );

      await page.goto('/cadastro?perfil=cliente');
      await expect(page.getByRole('heading', { name: 'Crie sua conta' })).toBeVisible();
      await noHorizontalScroll(page, `cadastro a ${width} px`);
    });

    test(`telas principais a ${width} px: sem rolagem horizontal e com a navegação na tela`, async ({
      page,
      request,
    }) => {
      const freelancer = await createUser(request, 'freelancer');
      const service = await createService(request, freelancer, 250);
      const client = await createUser(request, 'client');
      // Entregue: a sala mostra a entrega, as ações do cliente e o chat, o caso mais cheio.
      const contractId = await deliveredContract(request, client, freelancer, service);

      await openAs(page, client, '/');
      await settled(page);

      // A navegação funciona nesta largura: o link leva à tela.
      await page
        .getByRole('navigation', { name: 'Principal' })
        .getByRole('link', { name: 'Serviços', exact: true })
        .click();
      await expect(page).toHaveURL(/\/servicos$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Serviços' })).toBeVisible();

      for (const [where, path, heading] of [
        ['início', '/', { name: /^(Bom dia|Boa tarde|Boa noite),/ }],
        ['serviços', '/servicos', { level: 1, name: 'Serviços' }],
        ['sala da contratação', `/contratos/${contractId}`, { level: 1, name: service.title }],
        ['carteira', '/carteira', { level: 1, name: 'Carteira' }],
        ['perfil', '/perfil', { level: 1, name: 'Perfil' }],
      ] as const) {
        await page.goto(path);
        await expect(page.getByRole('heading', heading).first()).toBeVisible();
        await settled(page);
        await noHorizontalScroll(page, `${where} a ${width} px`);
        await navigationReachable(page, `${where} a ${width} px`);
      }
    });
  });
}
