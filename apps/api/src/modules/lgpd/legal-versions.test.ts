import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_LEGAL_VERSION,
  isLegalDocument,
  PUBLISHED_LEGAL_VERSIONS,
  type LegalDocument,
} from './legal-versions';

/** O texto dos documentos mora no front; a API repete as versões (ADR 54). */
const WEB_CONTENT = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'web',
  'src',
  'features',
  'legal',
  'content.ts',
);
const WEB_KIND: Record<LegalDocument, string> = {
  terms_of_use: 'termos',
  privacy_policy: 'privacidade',
};
const DOCS: LegalDocument[] = ['terms_of_use', 'privacy_policy'];

const numeric = (v: string): number[] => v.split('.').map(Number);
const ascending = (a: string, b: string): number => {
  const [x, y] = [numeric(a), numeric(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

describe('versões publicadas dos documentos legais (ADR 54)', () => {
  it('Termos de Uso 1.4 (ADR 58: prazo no horário de quem entrega e lembretes) e Política de Privacidade 1.4 são as vigentes', () => {
    expect(CURRENT_LEGAL_VERSION).toEqual({ terms_of_use: '1.4', privacy_policy: '1.4' });
    expect(PUBLISHED_LEGAL_VERSIONS.terms_of_use).toEqual(['1.0', '1.1', '1.2', '1.3', '1.4']);
    expect(PUBLISHED_LEGAL_VERSIONS.privacy_policy).toEqual(['1.0', '1.1', '1.2', '1.3', '1.4']);
  });

  it.each(DOCS)(
    '%s: a vigente é a última publicada, e a lista cresce sem repetir (a trilha antiga continua válida)',
    (doc) => {
      const list = PUBLISHED_LEGAL_VERSIONS[doc];
      expect(list.at(-1)).toBe(CURRENT_LEGAL_VERSION[doc]);
      expect([...list].sort(ascending)).toEqual(list);
      expect(new Set(list).size).toBe(list.length);
    },
  );

  it.each(DOCS)(
    '%s: a versão vigente e o histórico são os mesmos do front (apps/web/src/features/legal/content.ts)',
    (doc) => {
      const src = readFileSync(WEB_CONTENT, 'utf8');
      const kind = WEB_KIND[doc];
      const current = new RegExp(`LEGAL_VERSIONS[^=]*=\\s*\\{[^}]*\\b${kind}: '([\\d.]+)'`).exec(
        src,
      );
      expect(current?.[1]).toBe(CURRENT_LEGAL_VERSION[doc]);
      const history = [
        ...src.matchAll(new RegExp(`doc: '${kind}',\\s*version: '([\\d.]+)'`, 'g')),
      ].map((m) => m[1]!);
      expect(history.sort(ascending)).toEqual([...PUBLISHED_LEGAL_VERSIONS[doc]]);
    },
  );

  it('só termos e privacidade têm lista de versões', () => {
    expect(isLegalDocument('terms_of_use')).toBe(true);
    expect(isLegalDocument('privacy_policy')).toBe(true);
    expect(isLegalDocument('marketing')).toBe(false);
    expect(isLegalDocument('data_processing')).toBe(false);
  });
});
