import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  createAdmin,
  createService,
  createUser,
  deliveredContract,
  openAs,
  PASSWORD,
  settled,
} from './helpers';

/**
 * Saúde da moderação (ADR 47): depois de uma sinalização automática removida pela fila, o painel
 * mostra a fila, o tempo até decidir, o acerto por sinal e o período escolhido; a série sai em CSV
 * e o relatório diário da meta tem a sua linha e a sua chave (ADR 55). Desktop e mobile.
 */
test('painel de saúde da moderação: números, tabela de sinais, período, CSV e relatório', async ({
  page,
  request,
  isMobile,
}) => {
  const client = await createUser(request, 'client');
  const freelancer = await createUser(request, 'freelancer');
  const service = await createService(request, freelancer);
  const contractId = await deliveredContract(request, client, freelancer, service);
  const sent = await request.post(`/api/messaging/contracts/${contractId}`, {
    headers: { Authorization: `Bearer ${freelancer.token}` },
    data: { content: `Me paga no pix por fora ${Date.now().toString(36)}` },
  });
  expect(sent.ok(), await sent.text()).toBeTruthy();
  const messageId = ((await sent.json()) as { id: number }).id;
  const admin = await createAdmin(request);
  const adminHeaders = { Authorization: `Bearer ${admin.token}` };
  // A chave do relatório pode ter ficado desligada por uma execução que caiu no meio: parte ligada.
  const enableReport = async () => {
    const res = await request.put('/api/admin/settings/moderation_sla_report_enabled', {
      headers: adminHeaders,
      data: { value: true },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  };
  await enableReport();
  const queue = (await (
    await request.get('/api/admin/reports?status=pending', { headers: adminHeaders })
  ).json()) as { id: number; targetType: string; targetId: number }[];
  const group = queue.find((g) => g.targetType === 'message' && g.targetId === messageId)!;
  const removed = await request.post(`/api/admin/reports/${group.id}/remove-content`, {
    headers: adminHeaders,
    data: { note: 'Pagamento por fora.' },
  });
  expect(removed.ok(), await removed.text()).toBeTruthy();

  await openAs(page, admin, '/admin');
  await settled(page);
  const card = page.getByTestId('moderation-health');
  await expect(card.getByRole('heading', { name: 'Saúde da moderação' })).toBeVisible();
  await expect(card).toContainText('Esperando decisão');
  await expect(card).toContainText('Tempo até decidir');
  await expect(card).toContainText('Acerto da sinalização');
  await expect(
    card.getByRole('img', { name: /Sinalizações automáticas: Removidas: [1-9]/ }),
  ).toBeVisible();
  const signals = card.getByTestId('health-signals');
  await expect(signals.getByRole('row', { name: /^Pix / })).toBeVisible();
  await expect(signals.getByRole('row', { name: /^Negociar por fora / })).toBeVisible();

  // Série por dia (ADR 50): os dois gráficos com resumo acessível e a meta desenhada.
  const history = card.getByTestId('health-history');
  await expect(history.getByRole('img', { name: /^Decisões por dia/ })).toBeVisible();
  await expect(history.getByRole('img', { name: /meta de 24 h/ })).toBeVisible();
  await expect(history.locator('svg text', { hasText: 'meta 24 h' })).toBeVisible();

  // O período muda a janela e continua mostrando a remoção de agora.
  await card.getByRole('tab', { name: '7 dias' }).click();
  await expect(card.getByRole('tab', { name: '7 dias' })).toHaveAttribute('aria-selected', 'true');
  await expect(
    card.getByRole('img', { name: /Sinalizações automáticas: Removidas: [1-9]/ }),
  ).toBeVisible();

  // CSV da série (ADR 55): 7 dias inteiros mais hoje, nome pelas pontas, Excel pt-BR.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card.getByRole('button', { name: 'Exportar CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^escambo-moderacao-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/,
  );
  await expect(page.locator('.toast', { hasText: 'CSV da moderação baixado' })).toBeVisible();
  const csv = readFileSync((await download.path())!, 'utf8');
  const lines = csv.split('\r\n');
  expect(lines[0]).toBe(
    '\uFEFFdia;denuncias_recebidas;sinalizacoes_automaticas;decididas_com_acao;dispensadas;decididas_total;mediana_horas;meta_horas;acima_da_meta',
  );
  expect(lines).toHaveLength(10); // cabeçalho + 8 dias + linha vazia do CRLF final
  expect(lines[8]).toMatch(
    /^\d{4}-\d{2}-\d{2};[1-9]\d*;[1-9]\d*;[1-9]\d*;\d+;[1-9]\d*;\d+,\d;24;nao$/,
  );

  // O relatório diário da meta tem a sua linha; a chave dos parâmetros a desliga e religa.
  const line = card.getByTestId('health-report');
  await expect(line).toContainText('Relatório diário da meta: a partir das');
  if (!isMobile) {
    const row = page.getByTestId('setting-moderation_sla_report_enabled');
    const flag = row.getByRole('switch', { name: 'Relatório da meta da moderação' });
    try {
      await flag.click();
      await row.getByRole('button', { name: 'Salvar' }).click();
      await expect(
        page.locator('.toast', { hasText: 'Relatório da meta da moderação: desligado' }),
      ).toBeVisible();
      await expect(line).toContainText('desligado nos parâmetros da plataforma');
      await flag.click();
      await row.getByRole('button', { name: 'Salvar' }).click();
      await expect(
        page.locator('.toast', { hasText: 'Relatório da meta da moderação: ligado' }),
      ).toBeVisible();
      await expect(line).toContainText('Relatório diário da meta: a partir das');
    } finally {
      await enableReport();
    }
  }
});

/**
 * O link do e-mail do relatório (ADR 55) leva a /admin#health-title: sem sessão, a guarda manda
 * para o login lembrando a âncora; depois de entrar, o painel volta a ela, rola até o cartão e põe
 * o foco no título.
 */
test('link do relatório: entra e volta ao cartão da saúde da moderação', async ({
  page,
  request,
}) => {
  const admin = await createAdmin(request);
  await page.goto('/admin#health-title');
  await expect(page).toHaveURL(/\/login$/);
  const form = page.locator('form');
  await form.getByLabel('E-mail').fill(admin.email);
  await form.getByLabel('Senha').fill(PASSWORD);
  await form.locator('button[type="submit"]').click();

  await expect(page).toHaveURL(/\/admin#health-title$/);
  const title = page.locator('#health-title');
  await expect(title).toBeFocused();
  await expect(title).toBeInViewport();
});
