import { expect, test, type Locator, type Page } from '@playwright/test';
import { createUser, openAs, settled } from './helpers';

/**
 * Arrastar para ordenar o portfólio (ADR 49): no computador com o mouse, no celular com toque de
 * verdade (eventos de toque do Chrome, não mouse). A linha solta vai para o lugar, a posição é
 * anunciada, a ordem fica no servidor e sai igual no perfil público. Esc cancela no meio, e um
 * clique parado na alça perto da borda não rola a página nem muda a ordem.
 */

interface Point {
  x: number;
  y: number;
}

async function centerOf(locator: Locator): Promise<Point> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Arrasta de `from` até `to` em passos: mouse no computador, toque no celular. */
async function drag(page: Page, from: Point, to: Point, touch: boolean): Promise<void> {
  const steps = 12;
  if (!touch) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps });
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y }],
  });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x, y: from.y + ((to.y - from.y) * i) / steps }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('portfólio: arrasta pela alça, com mouse ou toque; Esc cancela; a ordem sai no perfil público', async ({
  page,
  request,
  isMobile,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const headers = { Authorization: `Bearer ${freelancer.token}` };
  const tag = Date.now().toString(36);
  const titles = [`Logo ${tag}`, `Site ${tag}`, `Cardápio ${tag}`, `Vitrine ${tag}`];
  for (const title of titles) {
    const res = await request.post('/api/profiles/portfolio', {
      headers,
      data: { title, externalUrl: `https://exemplo.com/${tag}` },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const [logo, site, cardapio, vitrine] = titles as [string, string, string, string];
  const serverOrder = async (): Promise<string[]> =>
    (
      (await (await request.get('/api/profiles/portfolio', { headers })).json()) as {
        title: string;
      }[]
    ).map((i) => i.title);

  await openAs(page, freelancer, '/perfil');
  await settled(page);
  const card = page.getByTestId('portfolio-card');
  const list = card.getByTestId('portfolio-list');
  await list.scrollIntoViewIfNeeded();
  const rows = card.locator('[data-testid^="portfolio-row-"] strong');
  const row = (title: string) =>
    card.locator('[data-testid^="portfolio-row-"]', { hasText: title });
  const grip = (title: string) => row(title).locator('.portfolio-grip');
  await expect(rows).toHaveText([logo, site, cardapio, vitrine]);
  // A mesma alça também pega pelo teclado (ADR 53), e o arraste por ponteiro segue igual.
  await expect(grip(logo)).toHaveAttribute('aria-pressed', 'false');

  // A última vai para o começo: solta acima da lista, presa no topo.
  const top = (await list.boundingBox())!.y;
  const from = await centerOf(grip(vitrine));
  await drag(page, from, { x: from.x, y: top - 30 }, isMobile);
  await expect(rows).toHaveText([vitrine, logo, site, cardapio]);
  await expect(card.locator('.portfolio-announce')).toHaveText(`${vitrine} agora é o 1º de 4.`);
  await expect.poll(serverOrder).toEqual([vitrine, logo, site, cardapio]);

  // O segundo vai para o fim: solta abaixo da lista, preso no fim.
  const box = (await list.boundingBox())!;
  const second = await centerOf(grip(logo));
  await drag(page, second, { x: second.x, y: box.y + box.height + 30 }, isMobile);
  await expect(rows).toHaveText([vitrine, site, cardapio, logo]);
  await expect(card.locator('.portfolio-announce')).toHaveText(`${logo} agora é o 4º de 4.`);
  await expect.poll(serverOrder).toEqual([vitrine, site, cardapio, logo]);

  if (!isMobile) {
    // Esc no meio do arraste: tudo volta ao lugar e nada é gravado.
    const start = await centerOf(grip(cardapio));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, top - 30, { steps: 8 });
    await expect(row(cardapio)).toHaveClass(/is-dragging/);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(row(cardapio)).not.toHaveClass(/is-dragging/);
    await expect(rows).toHaveText([vitrine, site, cardapio, logo]);
    // Todas as linhas voltam, não só a arrastada: as que abriram espaço também.
    const offsets = () =>
      card
        .locator('[data-testid^="portfolio-row-"]')
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform));
    await expect.poll(offsets).toEqual(['', '', '', '']);

    // Clique parado na alça perto da borda de baixo da janela: a página não rola sozinha e a
    // ordem não muda. Antes do limiar de movimento, a rolagem automática já começava aqui.
    await grip(site).evaluate((el) => {
      const r = el.getBoundingClientRect();
      window.scrollBy(0, r.top + r.height / 2 - (window.innerHeight - 20));
    });
    const edge = await centerOf(grip(site));
    expect(edge.y).toBeGreaterThan(page.viewportSize()!.height - 56);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.move(edge.x, edge.y);
    await page.mouse.down();
    await page.waitForTimeout(400);
    await page.mouse.up();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await expect(rows).toHaveText([vitrine, site, cardapio, logo]);
    await expect.poll(offsets).toEqual(['', '', '', '']);
    expect(await serverOrder()).toEqual([vitrine, site, cardapio, logo]);
  }

  // Fica depois de recarregar e sai igual no perfil público.
  await page.reload();
  await settled(page);
  await expect(rows).toHaveText([vitrine, site, cardapio, logo]);
  const { ulid } = (await (await request.get('/api/auth/me', { headers })).json()) as {
    ulid: string;
  };
  const client = await createUser(request, 'client');
  await openAs(page, client, `/freelancers/${ulid}`);
  await settled(page);
  await expect(page.locator('.portfolio-item')).toContainText([vitrine, site, cardapio, logo]);
});
