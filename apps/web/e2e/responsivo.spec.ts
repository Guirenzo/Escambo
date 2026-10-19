import { expect, test, type Page } from '@playwright/test';
import { createService, createUser, deliveredContract, openAs, settled } from './helpers';

/**
 * RNF-026: as telas principais no piso de 320 px e em largura de tablet (768 px), além dos 1440 px
 * e do Pixel 7 do smoke. Em cada largura e em cada tela:
 *  - a página não rola na horizontal (document.documentElement.scrollWidth <= innerWidth); tabelas
 *    e grades largas rolam dentro do próprio container;
 *  - a navegação principal está inteira na tela (barra inferior até 720 px, trilho de ícones até
 *    1024 px), cada link com nome acessível e alvo de toque de pelo menos 24 px (WCAG 2.5.8).
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

async function navigationReachable(page: Page, where: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Principal' });
  await expect(nav, `${where}: navegação principal visível`).toBeVisible();
  const viewport = page.viewportSize();
  expect(viewport, 'o projeto define a largura da janela').not.toBeNull();
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
        ['início', '/', { name: /^Olá,/ }],
        ['serviços', '/servicos', { level: 1, name: 'Serviços' }],
        ['sala da contratação', `/contratos/${contractId}`, { name: service.title }],
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
