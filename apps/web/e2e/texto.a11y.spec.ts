import { expect, test, type Page } from '@playwright/test';
import {
  createAdmin,
  createCompany,
  createService,
  createUser,
  deliveredContract,
  openAs,
  openLanding,
  pngFixture,
  settled,
  topUp,
  uploadImage,
  type TestUser,
} from './helpers';

/**
 * Texto que cresce e se espaça sem perder conteúdo (docs/acessibilidade.md):
 *  - 1.4.4 Redimensionar texto: só o texto a 200% (a raiz em 32 px, como o "tamanho da fonte" do
 *    navegador, que vale porque o CSS usa rem), na largura da tela;
 *  - 1.4.12 Espaçamento de texto: altura da linha 1,5, parágrafo com 2 em depois, letras a
 *    0,12 em e palavras a 0,16 em, o mínimo que o critério manda aguentar.
 * Em cada rota, nos dois casos: nenhum texto cortado (caixa com overflow hidden ou clip menor que
 * o conteúdo, incluindo reticências e corte de linhas) e nenhuma rolagem horizontal da página.
 * Os dados têm nomes compridos de propósito (anexos, trabalho do portfólio, link), onde um corte
 * apareceria primeiro.
 * A rolagem dentro de um contêiner (tabela larga, lista do chat) não é perda: o conteúdo continua
 * alcançável. O resumo marcado com `data-resumo` (a descrição do card de serviço, em duas linhas)
 * também não: o texto inteiro está na página para onde o card leva. Nem o rótulo dentro de um
 * gráfico (`role="img"`, com resumo em texto): os mesmos números estão na tabela logo abaixo. As
 * iniciais do avatar são decorativas (`aria-hidden`, o nome vem ao lado).
 */

const h = (t: string) => ({ Authorization: `Bearer ${t}` });

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
);
const LONG_FILE = 'manual-da-marca-versao-final-revisada-com-as-cores-novas';
const WORK_TITLE = 'Identidade visual completa da padaria do bairro com cardápio e sinalização';
const REPORT_TEXT =
  'Pediu para pagar fora da plataforma, por Pix, e mandou o telefone para combinar o resto da entrega sem a garantia do Escambo.';
const WORK_URL = 'https://exemplo.com/portfolio/identidade-visual-completa-da-padaria-do-bairro';

const SPACING_CSS = `
*, *::before, *::after {
  line-height: 1.5 !important;
  letter-spacing: 0.12em !important;
  word-spacing: 0.16em !important;
}
p { margin-bottom: 2em !important; }
`;
const TEXT_200_CSS = 'html { font-size: 200% !important; }';

/** Textos cortados e rolagem horizontal da página, como estão agora. */
async function lostContent(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // Desenhado de verdade: fora de um <details> fechado (o Chrome calcula a caixa do conteúdo
    // escondido mesmo sem desenhá-lo), visível e não transparente.
    const VISIBLE = {
      contentVisibilityAuto: true,
      visibilityProperty: true,
      opacityProperty: true,
    };
    const problems: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1)
      problems.push(`a página rola na horizontal: ${doc.scrollWidth} px em ${window.innerWidth}`);
    const describe = (el: Element): string => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} "${text}"`;
    };
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (el.closest('.sr-only, svg, [aria-hidden="true"], [data-resumo], [role="img"]')) continue;
      if (!(el.textContent ?? '').trim()) continue;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || !el.checkVisibility(VISIBLE)) continue;
      const clipX = st.overflowX === 'hidden' || st.overflowX === 'clip';
      const clipY = st.overflowY === 'hidden' || st.overflowY === 'clip';
      if (!clipX && !clipY) continue;
      const over =
        (clipX && el.scrollWidth > el.clientWidth + 1) ||
        (clipY && el.scrollHeight > el.clientHeight + 1);
      if (over)
        problems.push(
          `${describe(el)} cortado: ${el.scrollWidth}×${el.scrollHeight} em ${el.clientWidth}×${el.clientHeight}`,
        );
    }

    // Texto sobre texto: as caixas de cada linha (Range.getClientRects) de nós de texto diferentes
    // não podem se cruzar. Com um diálogo aberto, só o que está nele (o resto fica atrás de
    // propósito). Elemento fixo ou grudado (barra do celular, topo) só é comparado com o que está
    // na mesma camada: o conteúdo passa por baixo dele ao rolar, e isso não é sobreposição.
    const scope = document.querySelector('[role="dialog"]') ?? document.body;
    const layerOf = (el: Element): Element | null => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const pos = getComputedStyle(e).position;
        if (pos === 'fixed' || pos === 'sticky') return e;
      }
      return null;
    };
    // A parte da linha que aparece: recortada por cada ancestral que rola ou corta (a mensagem do
    // chat que rolou para fora da lista não está "sob" o campo de texto, está escondida).
    const visiblePart = (el: Element, r: DOMRect): DOMRect | null => {
      let { left, top, right, bottom } = r;
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
        const st = getComputedStyle(e);
        if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
        const c = e.getBoundingClientRect();
        left = Math.max(left, c.left);
        top = Math.max(top, c.top);
        right = Math.min(right, c.right);
        bottom = Math.min(bottom, c.bottom);
      }
      return right - left > 2 && bottom - top > 2
        ? new DOMRect(left, top, right - left, bottom - top)
        : null;
    };
    const boxes: { r: DOMRect; node: Text; el: Element; layer: Element | null }[] = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const el = node.parentElement;
      if (!el || !(node.textContent ?? '').trim()) continue;
      if (el.closest('.sr-only, svg, [aria-hidden="true"], [data-resumo], [role="img"]')) continue;
      if (!el.checkVisibility(VISIBLE)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const layer = layerOf(el);
      for (const line of Array.from(range.getClientRects())) {
        const r = visiblePart(el, line);
        if (r) boxes.push({ r, node, el, layer });
      }
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.node === b.node || a.layer !== b.layer) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const hh = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        // Linhas vizinhas encostam: só conta o cruzamento de mais de um quarto da altura.
        if (w > 2 && hh > Math.min(a.r.height, b.r.height) / 4)
          problems.push(`${describe(a.el)} sobre ${describe(b.el)}`);
      }
    return problems;
  });
}

for (const [criterion, css] of [
  ['1.4.4 texto a 200%', TEXT_200_CSS],
  ['1.4.12 espaçamento de texto', SPACING_CSS],
] as const) {
  test(`${criterion}: nenhuma tela perde conteúdo`, async ({ page, request }) => {
    test.setTimeout(240_000);
    const freelancer = await createUser(request, 'freelancer');
    const service = await createService(request, freelancer, 150);
    const client = await createUser(request, 'client');
    const contractId = await deliveredContract(request, client, freelancer, service);
    // Anexos de nome comprido no chat da contratação.
    for (const [who, file, mimeType, buffer] of [
      [freelancer, `${LONG_FILE}.png`, 'image/png', pngFixture()],
      [client, `${LONG_FILE}.pdf`, 'application/pdf', PDF],
    ] as const) {
      const sent = await request.post(`/api/messaging/contracts/${contractId}/attachments`, {
        headers: h(who.token),
        multipart: { file: { name: file, mimeType, buffer }, content: `Anexo ${file}` },
      });
      expect(sent.ok(), await sent.text()).toBeTruthy();
    }
    // Trabalho do portfólio com título e link compridos.
    const image = await uploadImage(request, freelancer, pngFixture(160, 100));
    const work = await request.post('/api/profiles/portfolio', {
      headers: h(freelancer.token),
      data: {
        title: WORK_TITLE,
        description: 'Trabalho entregue.',
        imageUrl: image,
        externalUrl: WORK_URL,
      },
    });
    expect(work.ok(), await work.text()).toBeTruthy();
    // Uma proposta de troca entre dois freelancers.
    const other = await createUser(request, 'freelancer');
    const otherService = await createService(request, other, 200);
    const barter = await request.post('/api/barters', {
      headers: h(other.token),
      data: {
        receiverId: freelancer.id,
        offeredServiceId: otherService.id,
        requestedServiceId: service.id,
        estimatedValueOffered: 200,
        estimatedValueRequested: 150,
      },
    });
    expect(barter.ok(), await barter.text()).toBeTruthy();
    // Uma denúncia de mensagem com descrição comprida na fila do admin.
    const message = await request.post(`/api/messaging/contracts/${contractId}`, {
      headers: h(freelancer.token),
      data: { content: `Me paga por fora no pix, sai mais barato ${Date.now().toString(36)}` },
    });
    expect(message.ok(), await message.text()).toBeTruthy();
    const report = await request.post('/api/reports', {
      headers: h(client.token),
      data: {
        targetType: 'message',
        targetId: ((await message.json()) as { id: number }).id,
        reason: 'off_platform',
        description: REPORT_TEXT,
      },
    });
    expect(report.ok(), await report.text()).toBeTruthy();
    // Um serviço com pacotes de nomes e itens compridos (RF-086) e a contratação do Premium.
    const packaged = await createService(request, other, 0, 0, {
      packages: (['basic', 'standard', 'premium'] as const).map((tier, i) => ({
        tier,
        name: `${['Essencial', 'Completo', 'Identidade visual completa'][i]} da padaria do bairro`,
        description: 'Arquivos prontos para impressão e para as redes sociais da marca.',
        price: 150 * (i + 1),
        deliveryDays: 3 + i * 4,
        revisions: 2 + i,
        features: ['Manual da marca com as cores e as fontes', 'Kit para as redes sociais'].slice(
          0,
          i + 1,
        ),
      })),
    });
    await topUp(request, client, 450);
    const packageContract = await request.post('/api/contracts', {
      headers: h(client.token),
      data: {
        freelancerId: other.id,
        serviceId: packaged.id,
        title: 'Identidade visual completa da padaria',
        description: 'Contratação do pacote Premium para a padaria do bairro.',
        price: 450,
        packageTier: 'premium',
      },
    });
    expect(packageContract.ok(), await packageContract.text()).toBeTruthy();
    const packageContractId = ((await packageContract.json()) as { id: number }).id;
    const { ulid } = (await (
      await request.get('/api/auth/me', { headers: h(freelancer.token) })
    ).json()) as { ulid: string };
    const admin = await createAdmin(request);
    // Conta de empresa de nomes compridos (RF-018), contratando o freelancer.
    const company = await createCompany(request, {
      tradeName: 'Padaria e Confeitaria Pão Quentinho do Bairro',
      legalName: 'Padaria e Confeitaria Pão Quentinho do Bairro Comércio de Alimentos Ltda',
    });
    await topUp(request, company, 150);
    const byCompany = await request.post('/api/contracts', {
      headers: h(company.token),
      data: {
        freelancerId: freelancer.id,
        serviceId: service.id,
        title: 'Cardápio da padaria',
        description: 'Contratação feita por uma conta de empresa.',
        price: 150,
      },
    });
    expect(byCompany.ok(), await byCompany.text()).toBeTruthy();
    const byCompanyId = ((await byCompany.json()) as { id: number }).id;

    const problems: string[] = [];
    const check = async (label: string): Promise<void> => {
      await page.addStyleTag({ content: css });
      // Duas voltas de quadro: o layout com o estilo novo já calculado.
      await page.evaluate(
        () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))),
      );
      for (const p of await lostContent(page)) problems.push(`${label}: ${p}`);
    };
    const visit = async (user: TestUser | null, path: string): Promise<void> => {
      if (user) await openAs(page, user, path);
      else await page.goto(path);
      await settled(page);
      await expect(page.locator('h1').first()).toBeVisible();
      await check(path);
    };
    // Página inicial sem sessão: como abre, e com as dúvidas abertas (o texto dos <details>).
    await openLanding(page);
    await check('/');
    await page
      .locator('details')
      .evaluateAll((all) => all.forEach((d) => ((d as HTMLDetailsElement).open = true)));
    await check('/ com as dúvidas abertas');
    for (const path of [
      '/cadastro?perfil=freelancer',
      '/cadastro?perfil=empresa',
      '/login',
      '/esqueci-senha',
      '/redefinir-senha?token=x',
      '/verificar-email',
      '/termos',
      '/privacidade',
      '/nao-existe',
    ])
      await visit(null, path);
    for (const path of [
      '/',
      '/servicos',
      `/servicos/${service.id}`,
      '/ranking',
      '/carteira',
      '/notificacoes',
      '/perfil',
      '/suporte',
      `/contratos/${contractId}`,
      `/servicos/${packaged.id}`,
      `/contratos/${packageContractId}`,
    ])
      await visit(client, path);
    await visit(freelancer, '/');
    await visit(freelancer, '/trocas');
    await visit(freelancer, '/perfil');
    await visit(freelancer, `/contratos/${contractId}`);
    await visit(other, '/trocas');
    await visit(admin, '/admin');
    // Documentos (RF-018, RF-020): o Perfil e a página da empresa, e a Sala com o selo.
    await visit(company, '/perfil');
    await visit(freelancer, `/empresas/${company.ulid}`);
    await visit(freelancer, `/contratos/${byCompanyId}`);

    // Perfil público com o portfólio e a galeria aberta.
    await visit(client, `/freelancers/${ulid}`);
    await page.getByRole('button', { name: `Ampliar ${WORK_TITLE}` }).click();
    await expect(page.getByRole('dialog', { name: WORK_TITLE })).toBeVisible();
    await check('galeria do portfólio');

    expect(problems).toEqual([]);
  });
}
