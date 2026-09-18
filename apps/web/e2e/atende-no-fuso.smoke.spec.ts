import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { createService, createUser, openAs, settled, type TestUser } from './helpers';

/**
 * Horário de atendimento no fuso do freelancer (ADR 48): quem está em Rio Branco (UTC−5) marca a
 * agenda no relógio de lá. O card e o perfil público dizem o fuso para quem vê de outro; o filtro
 * "Atende agora" compara com o agora do Acre, não com o de Brasília. Desktop e mobile.
 */

const PERIODS = ['morning', 'afternoon', 'evening'] as const;

/**
 * Dia da semana (0 = domingo) e período de agora num fuso, como a API calcula, e quantos minutos
 * faltam para o período virar (0h, 6h, 12h e 18h).
 */
function slotIn(zone: string): {
  day: number;
  period: (typeof PERIODS)[number] | null;
  minutesToTurn: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === 'weekday')!.value;
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const minute = Number(parts.find((p) => p.type === 'minute')!.value);
  const period = hour < 6 ? null : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return {
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday),
    period,
    minutesToTurn: (6 - (hour % 6)) * 60 - minute,
  };
}

async function setAgenda(
  request: APIRequestContext,
  who: TestUser,
  periods: Record<string, string[]>,
): Promise<void> {
  const res = await request.put('/api/profiles/freelancer', {
    headers: { Authorization: `Bearer ${who.token}` },
    data: {
      fullName: `Freela ${who.id}`,
      city: 'Rio Branco',
      isAvailable: true,
      availableDays: [0, 1, 2, 3, 4, 5, 6],
      availablePeriods: periods,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test('agenda no fuso do freelancer: card e perfil dizem o fuso; "Atende agora" usa o relógio de lá', async ({
  page,
  request,
}) => {
  const acre = slotIn('America/Rio_Branco');
  // O fluxo leva segundos; perto da virada do período no Acre, o que foi marcado deixaria de ser
  // o "agora" no meio do caminho e as asserções comparariam relógios diferentes.
  test.skip(acre.minutesToTurn <= 2, 'o período vira no Acre durante o teste');
  const freelancer = await createUser(request, 'freelancer');
  const prefs = await request.put('/api/notifications/preferences', {
    headers: { Authorization: `Bearer ${freelancer.token}` },
    data: { timezone: 'America/Rio_Branco' },
  });
  expect(prefs.ok(), await prefs.text()).toBeTruthy();
  // Só o período de agora no Acre, no dia de hoje de lá (madrugada lá: marca um qualquer).
  await setAgenda(request, freelancer, { [String(acre.day)]: [acre.period ?? 'morning'] });
  const tag = `fuso${Date.now().toString(36)}`;
  await createService(request, freelancer, 120, 0, { title: `${tag} identidade visual` });
  const client = await createUser(request, 'client');

  await openAs(page, client, '/servicos');
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(tag);
  await page.getByRole('button', { name: 'Buscar' }).click();
  const card = page.locator('.card.service', { hasText: tag });
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('owner-days')).toContainText('(horário de Rio Branco)');
  await expect(card.getByTestId('owner-now')).toHaveCount(acre.period ? 1 : 0);

  await page.getByRole('button', { name: 'Atende agora' }).click();
  await expect(page.getByRole('button', { name: 'Atende agora' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  if (acre.period) {
    await expect(card).toHaveCount(1);
  } else {
    await expect(page.getByText('Nenhum serviço com esses filtros')).toBeVisible();
  }

  // Trocando para outro período, ele some do "Atende agora" mesmo que esse período seja o de
  // agora em Brasília (o cliente vê de lá).
  const other = PERIODS.find((p) => p !== acre.period)!;
  await setAgenda(request, freelancer, { [String(acre.day)]: [other] });
  await page.reload();
  await settled(page);
  await page.getByPlaceholder('Buscar serviços…').fill(tag);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.getByRole('button', { name: 'Atende agora' }).click();
  await expect(page.getByText('Nenhum serviço com esses filtros')).toBeVisible();

  // Perfil público: a agenda vem com o fuso para quem está em Brasília.
  const me = await request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${freelancer.token}` },
  });
  const { ulid } = (await me.json()) as { ulid: string };
  await page.goto(`/freelancers/${ulid}`);
  await settled(page);
  await expect(page.getByTestId('available-days')).toContainText('(horário de Rio Branco)');
  await expect(page.getByTestId('available-now')).toHaveCount(0);
});
