import { describe, expect, it } from 'vitest';
import type { Consent, PublicUser } from '@escambo/types';
import { pickBanner } from './banners';

const user = (o: Partial<PublicUser> = {}): PublicUser => ({
  id: 1,
  ulid: 'u1',
  email: 'a@escambo.test',
  role: 'client',
  status: 'active',
  emailVerified: true,
  emailFrequency: 'instant',
  digestHour: 8,
  timezone: 'America/Sao_Paulo',
  timezoneChosen: true,
  quietHours: null,
  quietPass: null,
  ...o,
});
const ok: Consent[] = [
  { type: 'privacy_policy', version: '1.6', accepted: true, at: '' },
  { type: 'terms_of_use', version: '1.6', accepted: true, at: '' },
];
// A 1.5 permanece no histórico; a ciência do suporte é comunicada na 1.6.
const termosVelhos: Consent[] = [
  { type: 'privacy_policy', version: '1.6', accepted: true, at: '' },
  { type: 'terms_of_use', version: '1.5', accepted: true, at: '' },
];
const velho: Consent[] = [{ type: 'privacy_policy', version: '1.2', accepted: true, at: '' }];

/** Uma faixa por vez no topo do app (ADR 54 e 57): Política, Termos, fuso, e-mail. */
describe('pickBanner', () => {
  it('a suspensão tem prioridade e não depende da consulta de consentimentos', () => {
    expect(pickBanner(user({ status: 'suspended', emailVerified: false }), undefined, null)).toBe(
      'suspended',
    );
    expect(pickBanner(user({ status: 'suspended' }), velho, 'America/Manaus')).toBe('suspended');
  });
  it('sem sessão, nada', () => {
    expect(pickBanner(null, ok, 'America/Manaus')).toBeNull();
  });

  it('a política pendente vem antes de tudo', () => {
    expect(
      pickBanner(user({ emailVerified: false, timezoneChosen: false }), velho, 'America/Manaus'),
    ).toBe('legal');
    expect(pickBanner(user(), [], null)).toBe('legal');
  });

  it('Termos pendentes vêm depois da Política e antes do fuso', () => {
    expect(pickBanner(user({ timezoneChosen: false }), termosVelhos, 'America/Manaus')).toBe(
      'terms',
    );
    expect(pickBanner(user(), [velho[0]!, termosVelhos[1]!], null)).toBe('legal');
  });

  it('recusar a Política 1.6 encerra só a faixa dela: os Termos informativos vêm em seguida', () => {
    const old: Consent[] = [
      { type: 'privacy_policy', version: '1.4', accepted: true, at: '' },
      { type: 'terms_of_use', version: '1.4', accepted: true, at: '' },
    ];
    expect(pickBanner(user(), old, null)).toBe('legal');
    const rejected: Consent = { type: 'privacy_policy', version: '1.6', accepted: false, at: '' };
    expect(pickBanner(user(), [rejected, ...old], null)).toBe('terms');
    expect(pickBanner(user(), [ok[1]!, rejected, ...old], null)).toBeNull();
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
