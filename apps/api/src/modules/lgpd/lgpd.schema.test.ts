import { describe, expect, it } from 'vitest';
import { recordConsentSchema } from './lgpd.schema';

/** A trilha de consentimento só aceita versão publicada dos documentos legais (ADR 54). */
describe('recordConsentSchema', () => {
  it('aceita a versão vigente e as anteriores, e recusa uma que não existe', () => {
    expect(
      recordConsentSchema.safeParse({ type: 'privacy_policy', version: '1.3', accepted: true })
        .success,
    ).toBe(true);
    expect(
      recordConsentSchema.safeParse({ type: 'privacy_policy', version: '1.1', accepted: false })
        .success,
    ).toBe(true);
    const r = recordConsentSchema.safeParse({
      type: 'privacy_policy',
      version: '9.9',
      accepted: true,
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Versão desconhecida deste documento');
    expect(
      recordConsentSchema.safeParse({ type: 'terms_of_use', version: '1.3', accepted: true })
        .success,
    ).toBe(false); // os Termos estão na 1.2
  });

  it('os outros tipos de consentimento não têm lista de versões', () => {
    expect(
      recordConsentSchema.safeParse({ type: 'marketing', version: 'campanha-2026', accepted: true })
        .success,
    ).toBe(true);
  });
});
