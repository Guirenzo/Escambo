import type { APIRequestContext } from '@playwright/test';
import type { DataExportRequest, PlatformSetting, PublicSettings } from '@escambo/types';
import { expect, test } from '@playwright/test';
import { createAdmin, openAs, settled, type TestUser } from './helpers';

/** ADR 61: os prazos são editáveis; a política das contratações é somente para consulta. */
const h = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

async function adminSettings(
  request: APIRequestContext,
  admin: TestUser,
): Promise<PlatformSetting[]> {
  const res = await request.get('/api/admin/settings', { headers: h(admin) });
  expect(res.ok(), `GET /admin/settings → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as PlatformSetting[];
}

test('prazos configuráveis: limites, autoria, API pública, auditoria e regras fixas somente leitura', async ({
  page,
  request,
}) => {
  const admin = await createAdmin(request);
  const before = await adminSettings(request, admin);
  const targets = [
    {
      key: 'counter_offer_response_hours',
      label: 'Resposta a uma contraproposta',
      publicKey: 'counterOfferResponseHours',
      value: 72,
    },
    {
      key: 'extension_response_hours',
      label: 'Resposta a um pedido de extensão',
      publicKey: 'extensionResponseHours',
      value: 96,
    },
  ] as const;
  const originals = targets.map(({ key }) => {
    const setting = before.find((item) => item.key === key);
    expect(setting, `Parâmetro ${key} disponível na API admin`).toBeDefined();
    return setting!;
  });
  let writes = 0;

  try {
    await openAs(page, admin, '/admin');
    await settled(page);
    const card = page.getByTestId('settings-card');
    await expect(card).toBeVisible();

    for (const [index, { key, label, value }] of targets.entries()) {
      const row = card.getByTestId(`setting-${key}`);
      const input = row.getByLabel(label, { exact: true });
      const save = row.getByRole('button', { name: 'Salvar', exact: true });
      await expect(input).toHaveValue(String(originals[index]!.value));
      await expect(input).toHaveAttribute('type', 'number');
      await expect(input).toHaveAttribute('min', '24');
      await expect(input).toHaveAttribute('max', '168');
      await expect(input).toHaveAttribute('step', '1');
      await expect(save).toBeDisabled();
      await input.fill('23');
      await expect(save).toBeDisabled();
      await input.fill('169');
      await expect(save).toBeDisabled();
      await input.fill('24.5');
      await expect(save).toBeDisabled();
      await input.fill(originals[index]!.value === 24 ? '168' : '24');
      await expect(save).toBeEnabled();

      // Se a instalação já estiver no alvo, primeiro altera pela UI para exercitar a gravação.
      if (originals[index]!.value === value) {
        await input.fill('24');
        await save.click();
        await expect(page.locator('.toast', { hasText: `${label}: 24 horas` })).toBeVisible();
        await expect(row).toContainText(`por ${admin.email}`);
        await expect(save).toBeDisabled();
        writes++;
      }
      await input.fill(String(value));
      await save.click();
      await expect(page.locator('.toast', { hasText: `${label}: ${value} horas` })).toBeVisible();
      await expect(row).toContainText(`por ${admin.email}`);
      await expect(save).toBeDisabled();
      writes++;
    }

    await page.reload();
    await settled(page);
    const after = await adminSettings(request, admin);
    for (const { key, label, value } of targets) {
      await expect(card.getByTestId(`setting-${key}`).getByLabel(label)).toHaveValue(String(value));
      expect(after.find((item) => item.key === key)).toMatchObject({
        value,
        min: 24,
        max: 168,
        updatedBy: admin.email,
        updatedAt: expect.any(String),
      });
    }

    const publicResponse = await request.get('/api/settings/public');
    expect(publicResponse.ok(), await publicResponse.text()).toBeTruthy();
    const publicSettings = (await publicResponse.json()) as PublicSettings;
    for (const { publicKey, value } of targets) expect(publicSettings[publicKey]).toBe(value);
    expect(publicSettings.fixedContractRules).toEqual({
      includedRevisions: 2,
      maxOffers: 5,
      disputeWaitHours: 48,
      disputeTacitMarginHours: 24,
      dropoutWindowDays: 60,
      dropoutAlertAt: 3,
      dropoutAgreementDays: 7,
    });
    const rules = card.getByTestId('fixed-contract-rules');
    await expect(
      rules.getByRole('heading', { name: 'Regras fixas das contratações' }),
    ).toBeVisible();
    await expect(rules).toContainText('Somente leitura');
    await expect(rules).toContainText('2 revisões sem custo por entrega ou marco');
    await expect(rules).toContainText('Até 5 ofertas na negociação (3 rodadas)');
    await expect(rules).toContainText('Disputa manual após 48 horas');
    await expect(rules).toContainText('24 horas antes da aprovação tácita');
    await expect(rules).toContainText('contam por 60 dias; 3 abrem revisão humana');
    await expect(rules).toContainText('comum acordo em até 7 dias');
    await expect(rules.getByRole('listitem')).toHaveCount(4);
    await expect(rules.locator('form, input, select, textarea, button')).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'Painel de parâmetros sem rolagem horizontal').toBeLessThanOrEqual(0);

    // O histórico da conta nova comprova as gravações de auditoria pela API de portabilidade.
    // old_value/new_value não são exportados: podem citar terceiros.
    const exportResponse = await request.post('/api/lgpd/export-requests', { headers: h(admin) });
    expect(exportResponse.ok(), await exportResponse.text()).toBeTruthy();
    const exported = (await exportResponse.json()) as DataExportRequest;
    expect(exported.status).toBe('ready');
    expect(exported.downloadUrl).not.toBeNull();
    const download = await request.get(exported.downloadUrl!, { headers: h(admin) });
    expect(download.ok(), await download.text()).toBeTruthy();
    const data = (await download.json()) as {
      titular: { id: number };
      registrosDeSeguranca: { action: string; entity_type: string; created_at: string }[];
    };
    expect(data.titular.id).toBe(admin.id);
    const changed = data.registrosDeSeguranca.filter((entry) => entry.action === 'setting_updated');
    expect(changed).toHaveLength(writes);
    for (const entry of changed) {
      expect(entry).toMatchObject({
        entity_type: 'platform_setting',
        created_at: expect.any(String),
      });
    }
  } finally {
    for (const { key, value } of originals) {
      const restored = await request.put(`/api/admin/settings/${key}`, {
        headers: h(admin),
        data: { value },
      });
      expect(
        restored.ok(),
        `Restaurar ${key} → ${restored.status()} ${await restored.text()}`,
      ).toBeTruthy();
    }
  }
});
