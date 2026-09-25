import { describe, expect, it } from 'vitest';
import type { Consent, PublicUser } from '@escambo/types';
import { pickBanner } from './banners';

const user = (o: Partial<PublicUser> = {}): PublicUser => ({
  id: 1,
  ulid: 'u1',
  email: 'a@escambo.test',
  role: 'client',
  emailVerified: true,
  emailFrequency: 'instant',
  digestHour: 8,
  timezone: 'America/Sao_Paulo',
  timezoneChosen: true,
  quietHours: null,
  quietPass: null,
  ...o,
});
const ok: Consent[] = [{ type: 'privacy_policy', version: '1.4', accepted: true, at: '' }];
const velho: Consent[] = [{ type: 'privacy_policy', version: '1.2', accepted: true, at: '' }];

/** Uma faixa por vez no topo do app (ADR 54): legal, depois fuso, depois e-mail. */
describe('pickBanner', () => {
  it('sem sessão, nada', () => {
    expect(pickBanner(null, ok, 'America/Manaus')).toBeNull();
  });

  it('a política pendente vem antes de tudo', () => {
    expect(
      pickBanner(user({ emailVerified: false, timezoneChosen: false }), velho, 'America/Manaus'),
    ).toBe('legal');
    expect(pickBanner(user(), [], null)).toBe('legal');
  });

  it('consentimentos ainda não carregados (ou com erro): a faixa legal cala nesta carga', () => {
    expect(pickBanner(user({ emailVerified: false }), undefined, null)).toBe('verify-email');
    expect(pickBanner(user(), undefined, null)).toBeNull();
  });

  it('depois vem o fuso, e por último o e-mail', () => {
    expect(
      pickBanner(user({ timezoneChosen: false, emailVerified: false }), ok, 'America/Manaus'),
    ).toBe('timezone');
    expect(pickBanner(user({ timezoneChosen: false }), ok, 'America/Sao_Paulo')).toBeNull();
    expect(pickBanner(user({ emailVerified: false }), ok, null)).toBe('verify-email');
    expect(pickBanner(user(), ok, null)).toBeNull();
  });
});
