import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  createAdmin,
  createService,
  createUser,
  deliveredContract,
  openAs,
  openLanding,
  pngFixture,
  settled,
  topUp,
  uploadImage,
} from './helpers';

/**
 * Auditoria de teclado (WCAG 2.1.1, 2.1.2, 2.4.1, 2.4.3, 2.4.7 e 1.4.11 no anel de foco), no navegador
 * de verdade, desktop e celular. Em cada tela principal o Tab percorre a página inteira e, a cada
 * parada, o próprio navegador registra (no evento focusin) o que recebeu o foco:
 *  - a primeira parada é o "pular para o conteúdo", que leva o foco ao <main>;
 *  - a ordem segue o documento (nenhum tabindex positivo, nenhuma volta para trás) e a navegação
 *    vem antes do conteúdo, sem ir e voltar entre os dois;
 *  - nada recebe foco escondido (tamanho zero, invisível ou dentro de aria-hidden);
 *  - todo foco tem anel visível: contorno sólido de pelo menos 2 px com 3:1 contra o fundo em volta,
 *    ou o anel padrão do navegador (outline: auto), ou sombra;
 *  - o Tab chega ao fim da página (sem armadilha) e Shift+Tab volta.
 * Diálogos: abrem pelo teclado, prendem o Tab, fecham com Esc e devolvem o foco a quem abriu.
 * Controles com papel ARIA sobre elemento que não é nativo têm de estar numa lista conhecida, e
 * cada um responde a Enter, Espaço ou setas como o papel promete.
 */

/** Uma parada do Tab, medida no momento do foco. */
interface Stop {
  label: string;
  region: 'skip' | 'nav' | 'main' | 'other';
  /** Problema de visibilidade do elemento ou do anel; null quando está tudo certo. */
  problem: string | null;
  /** O elemento vem depois da parada anterior no documento. */
  forward: boolean;
}

declare global {
  interface Window {
    __stops?: Stop[];
  }
}

/** Instala o gravador de paradas: cada focusin vira um Stop, calculado na hora. */
async function recordFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__stops = [];
    let previous: Element | null = null;
    const parse = (c: string): [number, number, number, number] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const [r = 0, g = 0, b = 0, a = 1] = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [r, g, b, a];
    };
    const lum = ([r, g, b]: number[]): number => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r!) + 0.7152 * ch(g!) + 0.0722 * ch(b!);
    };
    /** Primeira cor de fundo opaca a partir de `el`, subindo (o branco da página no fim). */
    const backdrop = (el: Element | null): number[] => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c[3] > 0.5) return c.slice(0, 3);
      }
      return [255, 255, 255];
    };
    const ratio = (a: number[], b: number[]): number => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
      return (x + 0.05) / (y + 0.05);
    };
    document.addEventListener(
      'focusin',
      (e) => {
        const el = e.target as HTMLElement;
        const name = (
          el.getAttribute('aria-label') ||
          el.textContent ||
          el.getAttribute('title') ||
          el.getAttribute('name') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 50);
        const label = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${name}"`;
        const region = el.closest('.skip-link')
          ? 'skip'
          : el.closest('nav, aside')
            ? 'nav'
            : el.closest('main')
              ? 'main'
              : 'other';
        const st = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        let problem: string | null = null;
        if (rect.width < 2 || rect.height < 2 || st.visibility === 'hidden' || st.opacity === '0')
          problem = 'foco em elemento invisível';
        else if (el.closest('[aria-hidden="true"], [inert]'))
          problem = 'foco dentro de aria-hidden/inert';
        else if (el !== document.body && el.tagName !== 'MAIN') {
          const width = parseFloat(st.outlineWidth) || 0;
          const shadow = st.boxShadow !== 'none';
          if (st.outlineStyle === 'auto') problem = null;
          else if (st.outlineStyle !== 'none' && width >= 2) {
            const c = parse(st.outlineColor) ?? [0, 0, 0, 1];
            // Contorno para fora fica sobre o fundo de quem está em volta; para dentro, sobre o
            // fundo do próprio elemento.
            const inside = (parseFloat(st.outlineOffset) || 0) < 0;
            const bg = backdrop(inside ? el : el.parentElement);
            const a = c[3];
            const ring = [0, 1, 2].map((i) => c[i]! * a + bg[i]! * (1 - a));
            const r = ratio(ring, bg);
            if (r < 3) problem = `anel de foco com ${r.toFixed(2)}:1 contra o fundo`;
          } else if (!shadow) problem = 'sem anel de foco';
        }
        const forward =
          previous === null ||
          !!(previous.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        previous = el;
        window.__stops!.push({ label, region, problem, forward });
      },
      true,
    );
  });
}

/**
 * Percorre a página com Tab desde o topo até o foco sair do documento ou voltar ao começo, e
 * confere as regras do cabeçalho. Devolve as paradas.
 */
async function walk(page: Page, where: string, max = 700): Promise<Stop[]> {
  // Começa do topo do documento, como quem acabou de abrir a tela: um marcador focável no início
  // do <body> vira o ponto de partida do Tab e some antes da gravação.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const start = document.createElement('span');
    start.tabIndex = -1;
    document.body.prepend(start);
    start.focus();
    start.addEventListener('blur', () => start.remove(), { once: true });
  });
  await recordFocus(page);
  const url = page.url();
  let presses = 0;
  for (; presses < max; presses++) {
    await page.keyboard.press('Tab');
    if (presses % 20 !== 19) continue;
    // Fim da página: o foco saiu do documento agora ou já deu a volta e passou de novo pelo "pular".
    const ended = await page.evaluate(() => {
      const wrapped = (window.__stops ?? []).slice(1).some((s) => s.region === 'skip');
      return wrapped || document.activeElement === document.body;
    });
    if (ended) break;
  }
  const stops = await page.evaluate(() => window.__stops ?? []);
  expect(presses, `${where}: o Tab não chegou ao fim em ${max} toques`).toBeLessThan(max);
  // Receber o foco não muda de contexto (WCAG 3.2.1): a passada inteira fica na mesma tela.
  expect(page.url(), `${where}: o foco mudou de tela`).toBe(url);
  // Se deu a volta, só a primeira passada conta.
  const again = stops.findIndex((s, i) => i > 0 && s.region === 'skip');
  const pass = again > 0 ? stops.slice(0, again) : stops;
  expect(pass.length, `${where}: nenhuma parada`).toBeGreaterThan(2);
  expect(pass[0]!.label, `${where}: o primeiro Tab não é o "pular"`).toContain(
    'Pular para o conteúdo',
  );
  const problems = pass
    .map((s, i) => [
      s.problem ? `${i}: ${s.label}: ${s.problem}` : null,
      i > 0 && !s.forward ? `${i}: ${s.label}: volta para trás no documento` : null,
    ])
    .flat()
    .filter(Boolean);
  expect(problems, `${where}:\n${problems.join('\n')}`).toEqual([]);
  // Navegação antes do conteúdo, sem voltar à navegação depois de entrar no conteúdo.
  const firstMain = pass.findIndex((s) => s.region === 'main');
  expect(firstMain, `${where}: o Tab não entra no conteúdo`).toBeGreaterThan(0);
  const navAfter = pass.slice(firstMain).filter((s) => s.region === 'nav');
  expect(
    navAfter.map((s) => s.label),
    `${where}: navegação depois do conteúdo`,
  ).toEqual([]);
  return pass;
}

/** Nenhum tabindex positivo na página (ele tira a ordem do documento). */
async function noPositiveTabindex(page: Page, where: string): Promise<void> {
  const positive = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[tabindex]'))
      .filter((el) => Number(el.getAttribute('tabindex')) > 0)
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(positive, `${where}: tabindex positivo`).toEqual([]);
}

/**
 * Controles com papel ARIA interativo em elemento que não é nativo (ou elemento qualquer com
 * tabindex 0): têm de estar na lista conhecida, cada um com teste de teclado próprio. A região
 * da tabela larga (TableWrap) só existe para rolar com as setas, que o navegador já faz.
 */
const KNOWN_CUSTOM = ['crop-view', 'gallery-canvas', 'table-wrap'];
async function customControls(page: Page): Promise<string[]> {
  return page.evaluate((known) => {
    const native = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
    const sel =
      '[role="button"],[role="tab"],[role="switch"],[role="checkbox"],[role="radio"],[role="link"],[role="menuitem"],[role="option"],[role="slider"],[tabindex="0"]';
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
      .filter((el) => !native.has(el.tagName))
      .filter((el) => !known.some((k) => el.classList.contains(k)))
      .map((el) => el.outerHTML.slice(0, 100));
  }, KNOWN_CUSTOM);
}

/** Leva o foco ao controle pelo teclado: foca o anterior e dá Tab (o :focus-visible vale). */
async function tabInto(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  // Um marcador focável logo antes do alvo: o Tab seguinte é o que a pessoa faria para chegar nele.
  await target.evaluate((el) => {
    const mark = document.createElement('span');
    mark.tabIndex = -1;
    el.before(mark);
    mark.focus();
    mark.addEventListener('blur', () => mark.remove(), { once: true });
  });
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

/**
 * Diálogo: abre com a tecla dada a partir do botão, o foco entra, o Tab (para a frente e para trás)
 * não sai, Esc fecha e o foco volta para o botão.
 */
async function dialogRoundTrip(
  page: Page,
  opener: Locator,
  name: string | RegExp,
  key: 'Enter' | ' ' = 'Enter',
): Promise<void> {
  await tabInto(page, opener);
  await page.keyboard.press(key);
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  const inside = () =>
    dialog.evaluate((d) => d === document.activeElement || d.contains(document.activeElement));
  expect(await inside(), 'o foco entra no diálogo').toBe(true);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await inside(), `Tab ${i + 1} saiu do diálogo`).toBe(true);
  }
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside(), `Shift+Tab ${i + 1} saiu do diálogo`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
}

test.describe('teclado', () => {
  // A passada completa do Tab em várias telas é longa por natureza.
  test.slow();

  test('"pular para o conteúdo" leva o foco ao conteúdo, e Shift+Tab volta à navegação', async ({
    page,
    request,
  }) => {
    const user = await createUser(request, 'freelancer');
    await openAs(page, user, '/carteira');
    await settled(page);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Pular para o conteúdo' });
    await expect(skip).toBeFocused();
    // Visível quando focado: dentro da janela, por cima de tudo.
    const box = await skip.boundingBox();
    expect(box && box.y >= 0 && box.width > 40 && box.height >= 24).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.locator('main#conteudo')).toBeFocused();
    expect(new URL(page.url()).hash).toBe('');
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => document.activeElement?.closest('main') !== null);
    expect(first, 'o Tab depois do "pular" fica no conteúdo').toBe(true);
    // Shift+Tab do primeiro controle do conteúdo volta à navegação (sem armadilha para trás).
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    const back = await page.evaluate(
      () => document.activeElement?.closest('nav, aside, .skip-link') !== null,
    );
    expect(back).toBe(true);
  });

  test('página inicial sem sessão: "pular", ordem, foco visível no claro e no escuro, dúvidas pelo teclado', async ({
    page,
  }) => {
    await openLanding(page);
    await noPositiveTabindex(page, 'página inicial');
    expect(await customControls(page), 'página inicial: controle customizado novo').toEqual([]);
    const stops = await walk(page, 'página inicial');
    // Passa pelas chamadas do topo, do hero (fundo escuro), da página e do rodapé (escuro).
    for (const label of ['Criar conta', 'Ver como funciona', 'O que é torna?', 'Termos de Uso'])
      expect(
        stops.some((s) => s.label.includes(label)),
        `página inicial: o Tab não passa por "${label}"`,
      ).toBe(true);

    // "Pular para o conteúdo" leva o foco ao <main>, sem mudar a URL.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('body').evaluate((b) => {
      const start = document.createElement('span');
      start.tabIndex = -1;
      b.prepend(start);
      start.focus();
      start.addEventListener('blur', () => start.remove(), { once: true });
    });
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#conteudo')).toBeFocused();
    expect(new URL(page.url()).hash).toBe('');

    // As dúvidas abrem e fecham pelo teclado (Enter e Espaço no resumo nativo).
    const question = page.locator('summary', { hasText: 'Quanto custa usar o Escambo?' });
    const item = page.locator('details', { has: question });
    // O marcador vai antes do <details>: dentro dele, fechado, só o resumo aparece.
    await item.scrollIntoViewIfNeeded();
    await item.evaluate((d) => {
      const mark = document.createElement('span');
      mark.tabIndex = -1;
      d.before(mark);
      mark.focus();
      mark.addEventListener('blur', () => mark.remove(), { once: true });
    });
    await page.keyboard.press('Tab');
    await expect(question).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(item).toHaveAttribute('open', '');
    await expect(item.getByText(/Criar conta não custa nada/)).toBeVisible();
    await page.keyboard.press(' ');
    await expect(item).not.toHaveAttribute('open', '');
  });

  test('telas do freelancer: ordem, foco visível e fim da página pelo Tab', async ({
    page,
    request,
  }) => {
    const user = await createUser(request, 'freelancer');
    const service = await createService(request, user, 150);
    for (const [path, where] of [
      ['/', 'início'],
      ['/servicos', 'serviços'],
      [`/servicos/${service.id}`, 'detalhe do serviço'],
      ['/trocas', 'trocas'],
      ['/ranking', 'ranking'],
      ['/carteira', 'carteira'],
      ['/notificacoes', 'notificações'],
      ['/perfil', 'perfil'],
      ['/suporte', 'suporte'],
    ] as const) {
      await openAs(page, user, path);
      await settled(page);
      await noPositiveTabindex(page, where);
      expect(await customControls(page), `${where}: controle customizado novo`).toEqual([]);
      await walk(page, where);
    }
  });

  test('sala da contratação e painel admin: ordem, foco visível e fim da página', async ({
    page,
    request,
  }) => {
    const freelancer = await createUser(request, 'freelancer');
    const service = await createService(request, freelancer, 200);
    const client = await createUser(request, 'client');
    const contractId = await deliveredContract(request, client, freelancer, service);
    await openAs(page, client, `/contratos/${contractId}`);
    await settled(page);
    await noPositiveTabindex(page, 'sala');
    expect(await customControls(page)).toEqual([]);
    await walk(page, 'sala');

    const admin = await createAdmin(request);
    await openAs(page, admin, '/admin');
    await settled(page);
    await noPositiveTabindex(page, 'admin');
    expect(await customControls(page)).toEqual([]);
    await walk(page, 'admin', 1500);
  });

  test('diálogos abrem pelo teclado, prendem o Tab, fecham com Esc e devolvem o foco', async ({
    page,
    request,
  }) => {
    const freelancer = await createUser(request, 'freelancer');
    const service = await createService(request, freelancer, 200);
    const image = await uploadImage(request, freelancer, pngFixture(140 + (Date.now() % 200), 90));
    const added = await request.post('/api/profiles/portfolio', {
      headers: { Authorization: `Bearer ${freelancer.token}` },
      data: { title: 'Trabalho do teclado', imageUrl: image },
    });
    expect(added.ok(), await added.text()).toBeTruthy();
    const client = await createUser(request, 'client');
    await topUp(request, client, 400);

    await openAs(page, client, '/carteira');
    await settled(page);
    await dialogRoundTrip(page, page.getByRole('button', { name: 'Depositar' }), /Depositar/);

    await page.goto('/suporte');
    await settled(page);
    await dialogRoundTrip(
      page,
      page.getByRole('button', { name: 'Abrir chamado' }),
      /chamado/i,
      ' ',
    );

    await page.goto(`/servicos/${service.id}`);
    await settled(page);
    await dialogRoundTrip(page, page.getByRole('button', { name: 'Contratar' }).first(), /./);

    const { ulid } = (await (
      await request.get('/api/auth/me', {
        headers: { Authorization: `Bearer ${freelancer.token}` },
      })
    ).json()) as { ulid: string };
    await page.goto(`/freelancers/${ulid}`);
    await settled(page);
    await dialogRoundTrip(
      page,
      page.getByRole('button', { name: 'Ampliar Trabalho do teclado' }),
      'Trabalho do teclado',
    );

    // Imagem do chat (a que não usava o Modal): mesmo contrato.
    const contractId = await deliveredContract(request, client, freelancer, service);
    const sent = await request.post(`/api/messaging/contracts/${contractId}/attachments`, {
      headers: { Authorization: `Bearer ${freelancer.token}` },
      multipart: { file: { name: 'tela.png', mimeType: 'image/png', buffer: pngFixture() } },
    });
    expect(sent.ok(), await sent.text()).toBeTruthy();
    await page.goto(`/contratos/${contractId}`);
    await settled(page);
    await dialogRoundTrip(
      page,
      page.getByRole('button', { name: 'Abrir imagem tela.png' }),
      'tela.png',
    );
  });

  test('controles com estado respondem a Enter, Espaço e setas', async ({ page, request }) => {
    const freelancer = await createUser(request, 'freelancer');
    const service = await createService(request, freelancer, 200);
    const client = await createUser(request, 'client');
    await deliveredContract(request, client, freelancer, service);
    await openAs(page, client, '/carteira');
    await settled(page);

    // Abas (role="tab" em botão): Enter e Espaço escolhem; setas andam e escolhem.
    const reais = page.getByRole('tab', { name: 'Reais' });
    const creditos = page.getByRole('tab', { name: 'Créditos' });
    await tabInto(page, creditos);
    await page.keyboard.press('Enter');
    await expect(creditos).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(reais).toBeFocused();
    await expect(reais).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(creditos).toHaveAttribute('aria-selected', 'true');
    await reais.focus();
    await page.keyboard.press(' ');
    await expect(reais).toHaveAttribute('aria-selected', 'true');

    // Interruptor (checkbox com role="switch"): Espaço liga e desliga.
    await page.goto('/perfil');
    await settled(page);
    const freelancerPage = await page.context().newPage();
    await openAs(freelancerPage, freelancer, '/perfil');
    await settled(freelancerPage);
    const available = freelancerPage.getByRole('switch', { name: 'Aceitando novos pedidos' });
    await tabInto(freelancerPage, available);
    const before = await available.isChecked();
    await freelancerPage.keyboard.press(' ');
    await expect(available).toBeChecked({ checked: !before });
    await freelancerPage.keyboard.press(' ');
    await expect(available).toBeChecked({ checked: before });
    await freelancerPage.close();

    // Botão de alternância (aria-pressed): o chamado escolhido na lista do suporte.
    const ticket = await request.post('/api/support/tickets', {
      headers: { Authorization: `Bearer ${client.token}` },
      data: {
        category: 'other',
        subject: `Teclado ${client.id}`,
        description: 'Chamado para conferir a lista pelo teclado.',
      },
    });
    expect(ticket.ok(), await ticket.text()).toBeTruthy();
    await page.goto('/suporte');
    await settled(page);
    const item = page.getByRole('button', { name: new RegExp(`Teclado ${client.id}`) });
    await tabInto(page, item);
    await page.keyboard.press('Enter');
    await expect(item).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Detalhes do chamado' })).toBeVisible();
  });

  test('nota da avaliação (radiogroup) pelo teclado: setas escolhem, Espaço marca', async ({
    page,
    request,
  }) => {
    const freelancer = await createUser(request, 'freelancer');
    const service = await createService(request, freelancer, 200);
    const client = await createUser(request, 'client');
    const { completeContract } = await import('./helpers');
    const contractId = await completeContract(request, client, freelancer, service);
    await openAs(page, client, `/contratos/${contractId}`);
    await settled(page);
    const group = page.getByRole('radiogroup', { name: 'Nota' });
    await expect(group).toBeVisible();
    const radios = group.getByRole('radio');
    const first = radios.first();
    await tabInto(page, first);
    await page.keyboard.press('ArrowRight');
    await expect(radios.nth(1)).toBeFocused();
    await expect(radios.nth(1)).toBeChecked();
    // O rótulo da estrela focada ganha anel (o input é visualmente escondido).
    const ring = await radios.nth(1).evaluate((el) => {
      const label = el.closest('label') ?? el.parentElement!;
      const st = getComputedStyle(label);
      return `${st.outlineStyle} ${st.outlineWidth}`;
    });
    expect(ring).toMatch(/^solid [2-9]/);
  });
});
