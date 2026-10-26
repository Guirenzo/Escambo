import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  createAdmin,
  createService,
  createUser,
  deliveredContract,
  latestEmail,
  linkIn,
  openAs,
  openLanding,
  settled,
  type TestUser,
} from './helpers';

/**
 * O que o axe não decide sozinho e dá para provar no navegador (docs/acessibilidade.md):
 *  - cada rota tem título próprio, a página é pt-BR e a troca de rota é anunciada (2.4.2, 3.1.1);
 *  - alvos de toque de pelo menos 24 px, ou com espaço livre em volta (2.5.8, da WCAG 2.2);
 *  - contraste dos componentes do sistema de design em repouso, hover, foco e desabilitado, medido
 *    nas cores calculadas pelo próprio navegador a partir dos tokens de styles.css (1.4.3, 1.4.11);
 *  - erro de campo marcado como inválido e ligado ao campo pela descrição (3.3.1, 4.1.2);
 *  - avisos assíncronos em região viva (4.1.3);
 *  - movimento reduzido: animação e rolagem por código param (2.3.3).
 * E, lendo o próprio styles.css: o contraste dos pares de tokens, que nenhum contorno de foco foi
 * tirado sem substituto e que nada reordena a tela por CSS (a ordem visual é a do documento).
 */

const h = (t: string) => ({ Authorization: `Bearer ${t}` });

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
/** O CSS do app e o da página inicial (importado só por ela). Os tokens ficam no primeiro :root. */
const CSS = [read('../src/styles.css'), read('../src/features/landing/landing.css')].join('\n');

/** Contraste WCAG entre duas cores #rrggbb. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const s = parseInt(hex.slice(i, i + 2), 16) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

test('tokens de styles.css: contraste dos pares usados, foco nunca tirado sem troca e sem reordenação', () => {
  const root = /:root\s*{([^}]*)}/.exec(CSS)?.[1] ?? '';
  const token = (name: string): string => {
    const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(root)?.[1];
    expect(value, `token --${name}`).toBeTruthy();
    return value!.toLowerCase();
  };
  const WHITE = '#ffffff';
  // [o quê, frente, fundo, mínimo]: texto 4,5:1; contorno de componente e anel de foco 3:1.
  const pairs: [string, string, string, number][] = [
    ['texto sobre o fundo', token('text'), token('bg'), 4.5],
    ['texto secundário sobre o fundo', token('muted'), token('bg'), 4.5],
    ['texto secundário sobre o cartão', token('muted'), token('surface'), 4.5],
    ['texto secundário sobre o cartão alternativo', token('muted'), token('surface-2'), 4.5],
    ['botão primário (branco sobre verde)', WHITE, token('green'), 4.5],
    ['botão primário em hover', WHITE, token('green-hover'), 4.5],
    ['botão de perigo (branco sobre vermelho)', WHITE, token('red'), 4.5],
    ['âmbar (branco sobre âmbar)', WHITE, token('amber'), 4.5],
    ['link e aba ativa (verde sobre o cartão)', token('green'), token('surface'), 4.5],
    ['alternância ligada (verde sobre verde-claro)', token('green'), token('green-soft'), 4.5],
    ['aviso âmbar (texto sobre âmbar-claro)', token('amber-ink'), token('amber-soft'), 4.5],
    ['aviso azul (texto sobre azul-claro)', token('blue-ink'), token('blue-soft'), 4.5],
    ['erro (vermelho sobre o cartão)', token('red'), token('surface'), 4.5],
    ['contorno de campo sobre o cartão', token('border-input'), token('surface'), 3],
    ['contorno de campo sobre o fundo', token('border-input'), token('bg'), 3],
    ['contorno de campo sobre verde-claro', token('border-input'), token('green-soft'), 3],
    ['anel de foco sobre o cartão', token('focus'), token('surface'), 3],
    ['anel de foco sobre o fundo', token('focus'), token('bg'), 3],
    ['anel de foco sobre verde-claro', token('focus'), token('green-soft'), 3],
    // Página inicial: fundos claros (papel e verde-claro) e as seções escuras (hero, final, rodapé).
    ['texto sobre o papel', token('text'), token('paper'), 4.5],
    ['texto secundário sobre o papel', token('muted'), token('paper'), 4.5],
    ['texto secundário sobre o verde-claro da landing', token('muted'), token('mint'), 4.5],
    ['link e botão sobre o papel', token('green'), token('paper'), 4.5],
    ['link sobre o verde-claro da landing', token('green'), token('mint'), 4.5],
    ['contorno de campo sobre o papel', token('border-input'), token('paper'), 3],
    ['contorno de campo sobre o verde-claro da landing', token('border-input'), token('mint'), 3],
    ['anel de foco sobre o papel', token('focus'), token('paper'), 3],
    ['anel de foco sobre o verde-claro da landing', token('focus'), token('mint'), 3],
    ['texto no escuro (hero)', token('on-dark'), token('green-ink'), 4.5],
    ['texto secundário no escuro (hero)', token('on-dark-muted'), token('green-ink'), 4.5],
    ['texto no escuro (final e rodapé)', token('on-dark'), token('green-deep'), 4.5],
    ['texto secundário no escuro (rodapé)', token('on-dark-muted'), token('green-deep'), 4.5],
    ['texto secundário no cartão escuro', token('on-dark-muted'), token('green-ink-raised'), 4.5],
    ['âmbar claro no escuro (destaque)', token('amber-bright'), token('green-ink'), 4.5],
    ['botão âmbar (verde-escuro sobre âmbar)', token('green-ink'), token('amber-bright'), 4.5],
    ['botão âmbar em hover', token('green-ink'), token('amber-bright-hover'), 4.5],
    ['anel de foco no escuro (hero)', token('focus-on-dark'), token('green-ink'), 3],
    ['anel de foco no escuro (final e rodapé)', token('focus-on-dark'), token('green-deep'), 3],
    ['anel branco do botão âmbar', token('on-dark'), token('green-ink'), 3],
    // App v2: a barra lateral escura (--green-deep) e os fundos dos itens.
    ['item da lateral', token('nav-text'), token('green-deep'), 4.5],
    ['rótulo de grupo da lateral', token('nav-label'), token('green-deep'), 4.5],
    ['item da lateral em hover', token('on-dark'), token('nav-hover'), 4.5],
    ['item da lateral em hover (texto secundário)', token('nav-text'), token('nav-hover'), 4.5],
    ['item ativo da lateral', token('on-dark'), token('nav-active'), 4.5],
    ['ícone âmbar do item ativo', token('amber-bright'), token('nav-active'), 3],
    ['não lidas na lateral (escuro sobre âmbar)', token('green-deep'), token('amber-bright'), 4.5],
    ['nome no cartão de quem está logado', token('on-dark'), token('nav-card'), 4.5],
    ['papel no cartão de quem está logado', token('nav-text'), token('nav-card'), 4.5],
    ['anel de foco na lateral', token('focus-on-dark'), token('green-deep'), 3],
    ['anel de foco no item ativo', token('focus-on-dark'), token('nav-active'), 3],
    ['"Destaque" na capa (âmbar sobre o escuro)', token('amber-bright'), token('green-deep'), 4.5],
    ['status vermelho (texto sobre vermelho-claro)', token('red-ink'), token('red-soft'), 4.5],
    [
      '"Aceita troca" (âmbar escuro sobre âmbar-claro)',
      token('amber-ink'),
      token('amber-soft'),
      4.5,
    ],
    [
      'chip de filtro (verde-escuro sobre verde-claro)',
      token('green-ink'),
      token('green-soft'),
      4.5,
    ],
    ['texto secundário sobre o verde-claro do Início', token('muted'), token('mint'), 4.5],
    ['contorno de campo sobre o bloco claro', token('border-input'), token('surface-2'), 3],
    // App v3: atalhos e ícones em violeta, avatares de iniciais, degraus do pódio e o verde elevado.
    ['violeta (texto sobre violeta-claro)', token('violet-ink'), token('violet-soft'), 4.5],
    ['avatar de iniciais (branco sobre violeta)', WHITE, token('violet-ink'), 4.5],
    ['avatar de iniciais (branco sobre azul-escuro)', WHITE, token('blue-ink'), 4.5],
    ['avatar de iniciais (branco sobre vermelho-escuro)', WHITE, token('red-ink'), 4.5],
    ['avatar de iniciais (branco sobre verde-azulado)', WHITE, token('teal-ink'), 4.5],
    ['avatar de iniciais (branco sobre verde)', WHITE, token('green'), 4.5],
    ['degrau do 2º lugar (verde-escuro sobre prata)', token('green-deep'), token('silver'), 4.5],
    ['degrau do 3º lugar (verde-escuro sobre bronze)', token('green-deep'), token('bronze'), 4.5],
    [
      'texto no cartão escuro elevado (passos da troca, nível no pódio)',
      token('on-dark'),
      token('green-ink-raised'),
      4.5,
    ],
    [
      'contorno do botão claro sobre o escuro (Pedir saque)',
      token('on-dark-muted'),
      token('green-deep'),
      3,
    ],
    ['texto secundário sobre a não lida (verde-claro)', token('muted'), token('mint'), 4.5],
    // 1.50: o símbolo da marca sobre o claro (sobre o escuro, branco e --amber-bright já medidos).
    ['peça verde do símbolo sobre o branco', token('green'), WHITE, 3],
    ['peça âmbar do símbolo sobre o branco', token('brand-amber'), WHITE, 3],
    ['peça âmbar do símbolo sobre o fundo', token('brand-amber'), token('bg'), 3],
    ['peça âmbar do símbolo sobre o papel', token('brand-amber'), token('paper'), 3],
    // 1.50: gráficos (marcas 3:1 sobre o cartão e o bloco claro; número dentro do segmento 4,5:1).
    ['série verde do gráfico sobre o cartão', token('viz-green'), token('surface'), 3],
    ['série verde do gráfico sobre o bloco claro', token('viz-green'), token('surface-2'), 3],
    ['série azul do gráfico sobre o cartão', token('blue'), token('surface'), 3],
    ['série âmbar do gráfico sobre o cartão', token('brand-amber'), token('surface'), 3],
    ['linha da meta (âmbar) sobre o cartão', token('amber'), token('surface'), 3],
    ['rótulo da meta (âmbar escuro sobre o cartão)', token('amber-ink'), token('surface'), 4.5],
    ['número no segmento verde (branco)', WHITE, token('viz-green'), 4.5],
    ['número no segmento cinza (texto)', token('text'), token('viz-muted'), 4.5],
    ['número no segmento âmbar (texto)', token('text'), token('brand-amber'), 4.5],
    [
      'legenda do número em destaque (texto secundário sobre verde-claro)',
      token('muted'),
      token('green-soft'),
      4.5,
    ],
    // 1.50: filas do admin (estornar em vermelho escuro sobre o cartão).
    ['ação de estorno (vermelho escuro sobre o cartão)', token('red-ink'), token('surface'), 4.5],
  ];
  const rows = pairs.map(([what, fg, bg, min]) => ({ what, ratio: contrast(fg, bg), min }));
  test.info().annotations.push({
    type: 'contraste dos tokens',
    description: rows.map((r) => `${r.what}: ${r.ratio}:1 (mínimo ${r.min})`).join(' | '),
  });
  expect(rows.filter((r) => r.ratio < r.min)).toEqual([]);

  // "outline: none" só onde há outro indicador ou onde o alvo não é controle.
  const removed = [...CSS.matchAll(/([^{}]+){[^}]*outline:\s*none/g)].map((m) =>
    m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim(),
  );
  expect(removed.sort()).toEqual(
    ['.main:focus', '.modal:focus', '[data-hash-target]:focus'].sort(),
  );

  // Nada de reordenar por CSS: a ordem do Tab e do leitor é a do documento. A única inversão é a
  // do par rótulo/número das estatísticas (texto, não controle).
  const reorder = [
    ...CSS.matchAll(
      /(^|[;{\s])(order\s*:|flex-direction:\s*\w+-reverse|grid-auto-flow:\s*dense)/gm,
    ),
  ];
  expect(reorder.map((m) => m[2])).toEqual(['flex-direction: column-reverse']);
});

test('cada rota tem título próprio, a página é pt-BR e a troca de tela é anunciada', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 150);
  const client = await createUser(request, 'client');
  const contractId = await deliveredContract(request, client, freelancer, service);
  const { ulid } = (await (
    await request.get('/api/auth/me', { headers: h(freelancer.token) })
  ).json()) as {
    ulid: string;
  };
  const admin = await createAdmin(request);

  const titles = new Map<string, string>();
  const visit = async (user: TestUser | null, path: string): Promise<void> => {
    if (user) await openAs(page, user, path);
    else await page.goto(path);
    await settled(page);
    await expect(page.locator('h1').first()).toBeVisible();
    // O título das telas com dados chega com eles: espera sair do provisório.
    await expect(page).not.toHaveTitle(/^(Serviço|Contratação|Freelancer) · Escambo$/);
    expect(await page.locator('html').getAttribute('lang'), `${path}: idioma`).toBe('pt-BR');
    // A raiz sem sessão (página inicial) e com sessão (Início) são telas diferentes.
    titles.set(user ? path : `${path} (sem sessão)`, await page.title());
  };
  for (const path of [
    '/',
    '/cadastro',
    '/login',
    '/esqueci-senha',
    '/redefinir-senha?token=x',
    '/verificar-email',
    '/confirmar-novo-email?token=x',
    '/termos',
    '/privacidade',
    '/nao-existe',
  ])
    await visit(null, path);
  for (const path of [
    '/',
    '/servicos',
    `/servicos/${service.id}`,
    '/trocas',
    '/ranking',
    '/carteira',
    '/notificacoes',
    '/perfil',
    '/suporte',
    `/contratos/${contractId}`,
    `/freelancers/${ulid}`,
  ])
    await visit(client, path);
  await visit(admin, '/admin');

  const byTitle = new Map<string, string[]>();
  for (const [path, title] of titles) {
    expect(title, `${path}: título no formato "Tela · Escambo"`).toMatch(/ · Escambo$/);
    byTitle.set(title, [...(byTitle.get(title) ?? []), path]);
  }
  const repeated = [...byTitle].filter(([, paths]) => paths.length > 1);
  expect(repeated, 'rotas diferentes com o mesmo título').toEqual([]);

  // Troca de tela sem recarregar: a região viva repete o título novo.
  await openAs(page, client, '/');
  await settled(page);
  await page
    .getByRole('navigation', { name: 'Principal' })
    .getByRole('link', { name: 'Carteira', exact: true })
    .click();
  await expect(page.getByTestId('route-announcer')).toHaveText('Carteira · Escambo');
});

/**
 * Alvos menores que 24 px passam se estiverem no meio de um texto (link em frase) ou se um círculo
 * de 24 px centrado neles não encostar em outro alvo (a exceção de espaçamento da 2.5.8).
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel =
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"], [tabindex="0"]';
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && !el.closest('.sr-only');
    };
    // Campo de marcar dentro de rótulo: o alvo é o rótulo inteiro (clicar nele marca).
    const box = (el: Element): DOMRect => {
      const label = el.closest('label');
      return (el as HTMLInputElement).type === 'checkbox' ||
        (el as HTMLInputElement).type === 'radio'
        ? (label ?? el).getBoundingClientRect()
        : el.getBoundingClientRect();
    };
    const inText = (el: Element): boolean => {
      if (!(el.tagName === 'A' || el.classList.contains('link'))) return false;
      const parent = el.parentElement;
      if (!parent) return false;
      const own = Array.from(parent.childNodes)
        .filter((n) => n !== el)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
      return own.length > 0;
    };
    const targets = Array.from(document.querySelectorAll(sel)).filter(visible);
    const rects = targets.map(box);
    const problems: string[] = [];
    targets.forEach((el, i) => {
      const r = rects[i]!;
      if (r.width >= 23.5 && r.height >= 23.5) return;
      if (inText(el)) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const crowded = rects.some((o, j) => {
        if (j === i || targets[j]!.contains(el) || el.contains(targets[j]!)) return false;
        const dx = Math.max(o.left - cx, 0, cx - o.right);
        const dy = Math.max(o.top - cy, 0, cy - o.bottom);
        return Math.hypot(dx, dy) < 12;
      });
      if (crowded)
        problems.push(
          `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`,
        );
    });
    return problems;
  });
}

test('alvos de toque têm pelo menos 24 px ou espaço livre em volta', async ({ page, request }) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 150);
  const client = await createUser(request, 'client');
  const contractId = await deliveredContract(request, client, freelancer, service);
  const problems: string[] = [];
  for (const [user, path] of [
    [null, '/'],
    [null, '/cadastro'],
    [null, '/login'],
    [client, '/'],
    [client, '/servicos'],
    [client, `/servicos/${service.id}`],
    [client, '/trocas'],
    [client, '/ranking'],
    [client, '/carteira'],
    [client, '/notificacoes'],
    [client, '/perfil'],
    [client, '/suporte'],
    [client, `/contratos/${contractId}`],
    [freelancer, '/perfil'],
  ] as const) {
    if (user) await openAs(page, user, path);
    else await page.goto(path);
    await settled(page);
    problems.push(...(await smallTargets(page)).map((p) => `${path}: ${p}`));
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

// ---------- contraste dos estados ----------

/** Amostra dos componentes do sistema de design, com as classes de styles.css. */
const SAMPLE = `
  <section id="ds-amostra" class="card" aria-label="Amostra do sistema de design">
    <div class="svc-actions">
      <button type="button" data-k="botão primário">Primário</button>
      <button type="button" class="secondary" data-k="botão secundário">Secundário</button>
      <button type="button" class="ghost" data-k="botão fantasma">Fantasma</button>
      <button type="button" class="mini" data-k="botão mini">Mini</button>
      <button type="button" class="danger" data-k="botão de perigo">Perigo</button>
      <button type="button" class="link" data-k="botão-link">Link</button>
      <button type="button" class="toggle" data-k="alternância">Alternância</button>
      <button type="button" class="toggle on" data-k="alternância ligada">Ligada</button>
      <button type="button" class="icon-btn" data-k="botão de ícone" aria-label="Ícone">×</button>
    </div>
    <div class="tabs"><button type="button" data-k="aba">Aba</button><button type="button" class="active" data-k="aba ativa">Ativa</button></div>
    <input data-k="campo" value="Texto" aria-label="Campo" />
    <select data-k="lista" aria-label="Lista"><option>Opção</option></select>
    <textarea class="textarea" data-k="área de texto" aria-label="Área de texto">Texto</textarea>
    <label class="switch"><input type="checkbox" role="switch" data-k="interruptor" aria-label="Interruptor" /><span>Interruptor</span></label>
  </section>`;

interface Measure {
  /** Texto contra o fundo efetivo. */
  text: number;
  /** Borda (ou o trilho, no interruptor) contra o fundo em volta. */
  edge: number;
  /** Anel de foco contra o fundo em volta (0 quando não há anel). */
  ring: number;
}

/** Mede as cores calculadas: composição dos fundos semitransparentes até a raiz e a opacidade. */
async function measure(el: Locator): Promise<Measure> {
  return el.evaluate((node) => {
    const parse = (c: string): number[] => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return [0, 0, 0, 0];
      const [r = 0, g = 0, b = 0, a = 1] = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [r, g, b, a];
    };
    const over = (top: number[], under: number[]): number[] => {
      const a = top[3] ?? 1;
      return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a)).concat(1);
    };
    /** Fundo que aparece atrás de `n` (sem contar o próprio n), compondo de cima para baixo. */
    const behind = (n: Element | null): number[] => {
      const chain: Element[] = [];
      for (let p = n; p; p = p.parentElement) chain.unshift(p);
      let bg = [255, 255, 255, 1];
      for (const p of chain) bg = over(parse(getComputedStyle(p).backgroundColor), bg);
      return bg;
    };
    const lum = (c: number[]): number => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(c[0]!) + 0.7152 * ch(c[1]!) + 0.0722 * ch(c[2]!);
    };
    const ratio = (a: number[], b: number[]): number => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
      return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
    };
    const el = node as HTMLElement;
    const st = getComputedStyle(el);
    const around = behind(el.parentElement);
    let own = over(parse(st.backgroundColor), around);
    let fg = over(parse(st.color), own);
    // Opacidade do elemento (o desabilitado é 0,5): tudo dele se mistura com o que está atrás.
    const opacity = Number(st.opacity);
    if (opacity < 1) {
      own = over([...own.slice(0, 3), opacity], around);
      fg = over([...fg.slice(0, 3), opacity], around);
    }
    const isSwitch = el.getAttribute('role') === 'switch';
    const edgeColor = isSwitch ? own : over(parse(st.borderTopColor), around);
    const hasBorder = isSwitch || parseFloat(st.borderTopWidth) > 0;
    const ringColor =
      st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) >= 1
        ? over(parse(st.outlineColor), around)
        : null;
    return {
      text: ratio(fg, own),
      edge: hasBorder ? ratio(edgeColor, around) : 0,
      ring: ringColor ? ratio(ringColor, around) : 0,
    };
  });
}

test('contraste do sistema de design em repouso, hover, foco e desabilitado', async ({
  page,
  request,
}) => {
  // Sem transição: a cor medida é a do estado, não um quadro do meio da animação.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const user = await createUser(request, 'freelancer');
  await openAs(page, user, '/perfil');
  await settled(page);
  await page
    .locator('main .page')
    .first()
    .evaluate((main, html) => {
      main.insertAdjacentHTML('afterbegin', html);
    }, SAMPLE);
  const sample = page.locator('#ds-amostra');
  const keys = await sample
    .locator('[data-k]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-k')!));

  const rows: string[] = [];
  const problems: string[] = [];
  const TEXT_MIN = 4.5;
  const UI_MIN = 3;
  const isField = (k: string) => ['campo', 'lista', 'área de texto', 'interruptor'].includes(k);
  for (const k of keys) {
    const el = sample.locator(`[data-k="${k}"]`);
    await page.mouse.move(0, 0);
    await el.evaluate((n) => (n as HTMLElement).blur());
    const rest = await measure(el);
    await el.hover();
    const hover = await measure(el);
    await page.mouse.move(0, 0);
    // Foco pelo teclado (o :focus-visible só vale assim).
    await el.evaluate((n) => {
      const mark = document.createElement('span');
      mark.tabIndex = -1;
      n.before(mark);
      mark.focus();
      mark.addEventListener('blur', () => mark.remove(), { once: true });
    });
    await page.keyboard.press('Tab');
    await expect(el).toBeFocused();
    const focus = await measure(el);
    await el.evaluate((n) => (n as HTMLElement).blur());
    await el.evaluate((n) => n.setAttribute('disabled', ''));
    const disabled = await measure(el);
    await el.evaluate((n) => n.removeAttribute('disabled'));

    rows.push(
      `${k}: texto ${rest.text}/${hover.text}/${focus.text}/${disabled.text}` +
        (isField(k) ? `; contorno ${rest.edge}/${hover.edge}/${focus.edge}` : '') +
        `; anel ${focus.ring}`,
    );
    // O interruptor não tem texto próprio: o que conta é o trilho.
    if (k !== 'interruptor') {
      for (const [state, m] of [
        ['repouso', rest],
        ['hover', hover],
        ['foco', focus],
      ] as const)
        if (m.text < TEXT_MIN) problems.push(`${k} (${state}): texto ${m.text}:1`);
    }
    if (isField(k))
      for (const [state, m] of [
        ['repouso', rest],
        ['hover', hover],
      ] as const)
        if (m.edge < UI_MIN) problems.push(`${k} (${state}): contorno ${m.edge}:1`);
    if (focus.ring < UI_MIN) problems.push(`${k} (foco): anel ${focus.ring}:1`);
  }

  // Navegação principal: o link (texto ou só ícone, conforme a largura) em repouso, hover e ativo.
  // No celular, Perfil fica na folha do "Mais" da barra de baixo.
  const nav = page.getByRole('navigation', { name: 'Principal' });
  for (const [name, link] of [
    ['menu', nav.getByRole('link', { name: 'Carteira', exact: true })],
    ['menu ativo', nav.getByRole('link', { name: 'Perfil', exact: true })],
  ] as const) {
    if (!(await link.isVisible())) await nav.getByRole('button', { name: 'Mais' }).click();
    await page.mouse.move(0, 0);
    const rest = await measure(link);
    await link.hover();
    const hover = await measure(link);
    rows.push(`${name}: texto/ícone ${rest.text}/${hover.text}`);
    for (const [state, m] of [
      ['repouso', rest],
      ['hover', hover],
    ] as const)
      if (m.text < TEXT_MIN) problems.push(`${name} (${state}): ${m.text}:1`);
  }

  test.info().annotations.push({
    type: 'contraste (repouso/hover/foco/desabilitado)',
    description: rows.join(' | '),
  });
  expect(problems, `${problems.join('\n')}\n\n${rows.join('\n')}`).toEqual([]);
});

test('página inicial: contraste das chamadas em repouso, hover e foco, no claro e no escuro', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openLanding(page);
  const banner = page.getByRole('banner');
  const hero = page.locator('.lp-hero');
  const final = page.locator('.lp-final');
  const footer = page.getByRole('contentinfo');
  const targets: [string, Locator][] = [
    ['topo: Entrar', banner.getByRole('link', { name: 'Entrar', exact: true })],
    ['topo: Criar conta', banner.getByRole('link', { name: 'Criar conta', exact: true })],
    ['hero: Criar conta (âmbar)', hero.getByRole('link', { name: 'Criar conta', exact: true })],
    ['hero: Ver como funciona (contorno)', hero.getByRole('link', { name: 'Ver como funciona' })],
    ['hero: Entrar (link no texto)', hero.getByRole('link', { name: 'Entrar', exact: true })],
    ['caminho: Criar conta de cliente', page.getByRole('link', { name: /Criar conta de cliente/ })],
    ['categoria (chip)', page.locator('.lp-chip').first()],
    ['final: Criar conta (âmbar)', final.getByRole('link', { name: 'Criar conta', exact: true })],
    ['final: Entrar (contorno)', final.getByRole('link', { name: 'Entrar', exact: true })],
    ['rodapé: Termos de Uso', footer.getByRole('link', { name: 'Termos de Uso' })],
  ];
  // As âncoras do topo só existem a partir de 48rem (no celular saem, sem menu escondido).
  const anchor = page.getByRole('navigation', { name: 'Seções da página' }).getByRole('link', {
    name: 'Garantia',
  });
  if (await anchor.isVisible()) targets.push(['topo: âncora', anchor]);

  const rows: string[] = [];
  const problems: string[] = [];
  for (const [name, el] of targets) {
    await el.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const rest = await measure(el);
    await el.hover();
    const hover = await measure(el);
    await page.mouse.move(0, 0);
    // Foco pelo teclado (o :focus-visible só vale assim): Tab a partir de um marcador logo antes.
    await el.evaluate((n) => {
      const mark = document.createElement('span');
      mark.tabIndex = -1;
      n.before(mark);
      mark.focus();
      mark.addEventListener('blur', () => mark.remove(), { once: true });
    });
    await page.keyboard.press('Tab');
    await expect(el).toBeFocused();
    const focus = await measure(el);
    await el.evaluate((n) => (n as HTMLElement).blur());
    rows.push(`${name}: texto ${rest.text}/${hover.text}/${focus.text}; anel ${focus.ring}`);
    for (const [state, m] of [
      ['repouso', rest],
      ['hover', hover],
      ['foco', focus],
    ] as const)
      if (m.text < 4.5) problems.push(`${name} (${state}): texto ${m.text}:1`);
    if (focus.ring < 3) problems.push(`${name} (foco): anel ${focus.ring}:1`);
  }
  test.info().annotations.push({
    type: 'contraste da página inicial (repouso/hover/foco)',
    description: rows.join(' | '),
  });
  expect(problems, `${problems.join('\n')}\n\n${rows.join('\n')}`).toEqual([]);
});

test('erros de campo ficam marcados e ligados ao campo, e os avisos vão para regiões vivas', async ({
  page,
  request,
}) => {
  const user = await createUser(request, 'client');
  await openAs(page, user, '/perfil');
  await settled(page);

  // Propósito dos campos pessoais (WCAG 1.3.5): nome, cidade, telefone e e-mail com autocomplete.
  await expect(page.getByLabel('Nome', { exact: true }).first()).toHaveAttribute(
    'autocomplete',
    'name',
  );
  await expect(page.getByLabel('Cidade', { exact: true }).first()).toHaveAttribute(
    'autocomplete',
    'address-level2',
  );
  await expect(page.getByLabel('Telefone com DDD')).toHaveAttribute('autocomplete', 'tel-national');
  await expect(page.getByLabel('Novo e-mail')).toHaveAttribute('autocomplete', 'email');

  // A região viva dos avisos já existe antes do primeiro aviso (senão o leitor pode não ler).
  const status = page.locator('.toaster [role="status"][aria-live="polite"]');
  await expect(status).toHaveCount(1);

  // Senha: confirmação diferente.
  const senha = page.getByRole('form', { name: 'Trocar senha' });
  await senha.getByLabel('Senha atual').fill('Escambo@123');
  await senha.getByLabel('Nova senha', { exact: true }).fill('NovaSenha@456');
  await senha.getByLabel('Confirmar nova senha').fill('OutraSenha@789');
  await senha.getByRole('button', { name: 'Trocar senha' }).click();
  const confirmar = senha.getByLabel('Confirmar nova senha');
  await expect(confirmar).toHaveAttribute('aria-invalid', 'true');
  await expect(confirmar).toHaveAccessibleDescription('As senhas não conferem');
  await expect(confirmar).toBeFocused();

  // E-mail: senha atual errada (resposta da API).
  const email = page.getByRole('form', { name: 'Trocar e-mail' });
  await email.getByLabel('Novo e-mail').fill(`outro-${user.id}@escambo.test`);
  await email.getByLabel('Senha atual').fill('nao-e-a-senha');
  await email.getByRole('button', { name: 'Trocar e-mail' }).click();
  const atual = email.getByLabel('Senha atual');
  await expect(atual).toHaveAttribute('aria-invalid', 'true');
  await expect(atual).toHaveAccessibleDescription('Senha atual incorreta');

  // Telefone inválido: erro e dica na descrição do campo.
  const fone = page.getByRole('form', { name: 'Telefone da conta' });
  await fone.getByLabel('Telefone com DDD').fill('123');
  await fone.getByRole('button', { name: 'Salvar telefone' }).click();
  const campo = fone.getByLabel('Telefone com DDD');
  await expect(campo).toHaveAttribute('aria-invalid', 'true');
  await expect(fone.getByRole('alert')).toBeVisible();
  const erro = (await fone.getByRole('alert').textContent())!.trim();
  await expect(campo).toHaveAccessibleDescription(
    new RegExp(erro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );

  // Sucesso entra na região educada.
  await campo.fill('47 99999 1234');
  await fone.getByRole('button', { name: 'Salvar telefone' }).click();
  await expect(status).toContainText('Telefone salvo.');

  // Erro assíncrono vira alerta (fora da região educada): o reenvio da confirmação falha.
  await page.route('**/api/auth/resend-verification', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"x","message":"Serviço de e-mail fora do ar"}',
    }),
  );
  await page.goto('/');
  await settled(page);
  await page.getByTestId('verify-banner').getByRole('button', { name: 'Reenviar e-mail' }).click();
  const alert = page.locator('.toaster [role="alert"]');
  await expect(alert).toContainText('Serviço de e-mail fora do ar');
  await expect(status).not.toContainText('Serviço de e-mail fora do ar');

  // Redefinir senha: senhas diferentes.
  const admin = await createAdmin(request);
  const forgot = await request.post('/api/auth/forgot-password', { data: { email: user.email } });
  expect(forgot.ok()).toBeTruthy();
  const link = new URL(linkIn((await latestEmail(request, admin, user.id, 'password_reset')).text));
  await page.goto(`${link.pathname}${link.search}`);
  await page.getByLabel('Nova senha', { exact: true }).fill('NovaSenha@456');
  await page.getByLabel('Confirmar nova senha').fill('OutraSenha@789');
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByLabel('Confirmar nova senha')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Confirmar nova senha')).toHaveAccessibleDescription(
    'As senhas não conferem',
  );
});

test('movimento reduzido: animações param e o chat rola sem animação', async ({
  page,
  request,
}) => {
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer, 150);
  const client = await createUser(request, 'client');
  const contractId = await deliveredContract(request, client, freelancer, service);
  // Registra os pedidos de rolagem do chat.
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __scrolls: string[] }).__scrolls = calls;
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (this: Element, ...args: unknown[]) {
      const opts = args[0] as ScrollToOptions | undefined;
      calls.push(String(opts?.behavior));
      return (original as (...a: unknown[]) => void).apply(this, args);
    } as typeof Element.prototype.scrollTo;
  });
  const scrolls = () =>
    page.evaluate(() => (window as unknown as { __scrolls: string[] }).__scrolls);
  const send = async (text: string) => {
    const res = await request.post(`/api/messaging/contracts/${contractId}`, {
      headers: h(freelancer.token),
      data: { content: text },
    });
    expect(res.ok()).toBeTruthy();
  };

  // A mensagem já está no histórico: ao abrir, o chat rola até ela (sem depender do tempo real).
  await send('Primeira mensagem');

  // Sem a preferência: rolagem suave.
  await openAs(page, client, `/contratos/${contractId}`);
  await settled(page);
  await expect(page.getByText('Primeira mensagem')).toBeVisible();
  await expect.poll(scrolls).toContain('smooth');

  // Com a preferência: nenhuma animação, nenhuma transição, rolagem instantânea.
  await send('Segunda mensagem');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await settled(page);
  await expect(page.getByText('Segunda mensagem')).toBeVisible();
  await expect.poll(scrolls).toContain('auto');
  expect(await scrolls()).not.toContain('smooth');
  const motion = await page.evaluate(() => {
    const probe = (cls: string) => {
      const el = document.createElement('div');
      el.className = cls;
      document.body.append(el);
      const st = getComputedStyle(el);
      const out = `${cls}: ${st.animationDuration} x${st.animationIterationCount}, transição ${st.transitionDuration}`;
      el.remove();
      return out;
    };
    const button = getComputedStyle(document.querySelector('button')!);
    return [
      probe('skeleton'),
      probe('pulse-mark'),
      probe('toast'),
      `button: transição ${button.transitionDuration.split(',')[0]}`,
    ];
  });
  for (const line of motion) {
    expect(line, line).not.toMatch(/\b(0\.[1-9]|[1-9])[\d.]*s\b/);
    expect(line, line).not.toMatch(/infinite/);
  }
});
