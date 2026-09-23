import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createUser, openAs, settled } from './helpers';

/**
 * Pegar e soltar o portfólio pelo teclado (ADR 53): espaço pega, setas movem sem gravar, espaço
 * solta e grava uma vez só, Esc e Tab cancelam. O que se prova aqui, e não no jsdom, é o navegador
 * de verdade: quantas requisições saem, que o motor do arraste por ponteiro não é acionado (nenhuma
 * linha ganha deslocamento) e que a alça nova passa no axe, inclusive com um item na mão.
 */

test('portfólio pelo teclado: pega, move sem gravar, solta uma vez; Esc e Tab cancelam', async ({
  page,
  request,
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

  // Conta as gravações de ordem que saem do navegador na jornada inteira.
  let saves = 0;
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/profiles/portfolio/order')) saves += 1;
  });

  await openAs(page, freelancer, '/perfil');
  await settled(page);
  const card = page.getByTestId('portfolio-card');
  const list = card.getByTestId('portfolio-list');
  await list.scrollIntoViewIfNeeded();
  const rows = card.locator('[data-testid^="portfolio-row-"] strong');
  const row = (title: string) =>
    card.locator('[data-testid^="portfolio-row-"]', { hasText: title });
  const grip = (title: string) => row(title).getByRole('button', { name: `Reordenar ${title}` });
  const announce = card.locator('.portfolio-announce');
  /** Nenhuma linha pode carregar deslocamento: este caminho não encosta no motor do ponteiro. */
  const offsets = () =>
    card
      .locator('[data-testid^="portfolio-row-"]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform));

  await expect(rows).toHaveText([logo, site, cardapio, vitrine]);

  // O contrato da alça: botão de verdade, com nome próprio e a dica ligada.
  await expect(grip(vitrine)).toHaveAttribute('aria-pressed', 'false');
  const hintId = await grip(vitrine).getAttribute('aria-describedby');
  expect(hintId).toBeTruthy();
  await expect(page.locator(`#${hintId}`)).toContainText('espaço pega');

  // Pega a última e sobe três vezes: a tela já mostra a ordem nova, o servidor ainda não.
  await grip(vitrine).focus();
  await page.keyboard.press(' ');
  await expect(grip(vitrine)).toHaveAttribute('aria-pressed', 'true');
  await expect(announce).toHaveText(
    `Pegou ${vitrine}, 4º de 4. Setas movem, espaço solta, Esc ou Tab cancela.`,
  );
  await expect(row(vitrine)).toHaveClass(/is-grabbed/);

  // Com o item na mão, o axe: estado válido, dica existente e a lista continua sendo lista.
  const grabbed = await new AxeBuilder({ page })
    .include('[data-testid="portfolio-card"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    grabbed.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);

  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(rows).toHaveText([vitrine, logo, site, cardapio]);
  await expect(announce).toHaveText('1º de 4.');
  expect(await serverOrder()).toEqual([logo, site, cardapio, vitrine]); // ainda intacto
  expect(saves).toBe(0);

  // Na ponta, avisa em vez de calar, e nada muda.
  await page.keyboard.press('ArrowUp');
  await expect(announce).toHaveText('Começo da lista. 1º de 4.');
  await expect(rows).toHaveText([vitrine, logo, site, cardapio]);

  // Solta: uma gravação só para a jornada inteira, e o foco continua na alça.
  await page.keyboard.press(' ');
  await expect(announce).toHaveText(`${vitrine} agora é o 1º de 4.`);
  await expect(grip(vitrine)).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(serverOrder).toEqual([vitrine, logo, site, cardapio]);
  expect(saves).toBe(1);
  await expect(grip(vitrine)).toBeFocused();
  await expect.poll(offsets).toEqual(['', '', '', '']);

  // Esc no meio: a ordem volta, nada é gravado e o foco fica onde estava.
  await grip(site).focus();
  await page.keyboard.press(' ');
  await page.keyboard.press('ArrowUp');
  await expect(rows).toHaveText([vitrine, site, logo, cardapio]);
  await page.keyboard.press('Escape');
  await expect(announce).toHaveText(`Cancelado. ${site} continua no 3º de 4.`);
  await expect(rows).toHaveText([vitrine, logo, site, cardapio]);
  await expect(grip(site)).toBeFocused();
  expect(saves).toBe(1);

  // Tab no meio: cancela também, e o foco sai da alça (sem armadilha).
  await grip(cardapio).focus();
  await page.keyboard.press(' ');
  await page.keyboard.press('ArrowUp');
  await expect(rows).toHaveText([vitrine, logo, cardapio, site]);
  await page.keyboard.press('Tab');
  await expect(rows).toHaveText([vitrine, logo, site, cardapio]);
  await expect(grip(cardapio)).not.toBeFocused();
  expect(saves).toBe(1);
  expect(await serverOrder()).toEqual([vitrine, logo, site, cardapio]);

  // Home leva à primeira posição de uma vez.
  await grip(cardapio).focus();
  await page.keyboard.press(' ');
  await page.keyboard.press('Home');
  await expect(rows).toHaveText([cardapio, vitrine, logo, site]);
  await page.keyboard.press(' ');
  await expect.poll(serverOrder).toEqual([cardapio, vitrine, logo, site]);
  expect(saves).toBe(2);

  // Pegar e soltar no mesmo lugar não gasta gravação.
  await grip(logo).focus();
  await page.keyboard.press(' ');
  await page.keyboard.press(' ');
  await expect(announce).toHaveText(`${logo} continua no 3º de 4.`);
  expect(saves).toBe(2);

  // Fica depois de recarregar.
  await page.reload();
  await settled(page);
  await expect(rows).toHaveText([cardapio, vitrine, logo, site]);
  await expect.poll(offsets).toEqual(['', '', '', '']);
});
