import type { Consent } from '@escambo/types';
import { LEGAL_CHANGES, LEGAL_VERSIONS, type LegalChange, type LegalKind } from './content';

/** Comparação numérica por segmento: '1.10' vem depois de '1.9'. Positivo se `a` é mais nova. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const CONSENT_TYPE: Record<LegalKind, Consent['type']> = {
  termos: 'terms_of_use',
  privacidade: 'privacy_policy',
};

/**
 * A pessoa ainda não respondeu à versão vigente deste documento? Vale o registro MAIS RECENTE do
 * tipo (a lista já vem da mais nova para a mais antiga): aceito ou recusado contam como resposta.
 * Sem registro nenhum, também está pendente.
 */
export function legalAckPending(consents: readonly Consent[], kind: LegalKind): boolean {
  const latest = consents.find((c) => c.type === CONSENT_TYPE[kind]);
  return !latest || latest.version !== LEGAL_VERSIONS[kind];
}

/** A versão mais recente que a pessoa respondeu para este documento, ou null. */
export function answeredVersion(consents: readonly Consent[], kind: LegalKind): string | null {
  return consents.find((c) => c.type === CONSENT_TYPE[kind])?.version ?? null;
}

/**
 * O que mudou desde a versão que a pessoa respondeu, da mais nova para a mais antiga. Sem
 * versão respondida, só a vigente: quem nunca respondeu não precisa ouvir o histórico inteiro.
 */
export function changesSince(kind: LegalKind, version: string | null): LegalChange[] {
  const mine = LEGAL_CHANGES.filter((c) => c.doc === kind);
  if (version === null) return mine.filter((c) => c.version === LEGAL_VERSIONS[kind]);
  return mine.filter((c) => compareVersions(c.version, version) > 0);
}
