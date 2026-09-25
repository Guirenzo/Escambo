/**
 * Versões publicadas dos documentos legais (ADR 54). Mudou o texto em
 * apps/web/src/features/legal/content.ts, muda aqui — mesma disciplina de utils/timezone.ts. A API
 * precisa conhecê-las para gravar o consentimento do cadastro na versão vigente e para recusar
 * uma versão que não existe. O texto de cada versão está no git, na tag da release.
 */

export type LegalDocument = 'terms_of_use' | 'privacy_policy';

export const PUBLISHED_LEGAL_VERSIONS: Record<LegalDocument, readonly string[]> = {
  terms_of_use: ['1.0', '1.1', '1.2'],
  privacy_policy: ['1.0', '1.1', '1.2', '1.3', '1.4'],
};

export const CURRENT_LEGAL_VERSION: Record<LegalDocument, string> = {
  terms_of_use: '1.2',
  privacy_policy: '1.4',
};

export const isLegalDocument = (type: string): type is LegalDocument =>
  type === 'terms_of_use' || type === 'privacy_policy';
