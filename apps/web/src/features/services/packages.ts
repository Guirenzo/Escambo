import type { PackageTier, ServicePackage } from '@escambo/types';

/**
 * Pacotes do serviço (RF-086, RN-068), com as mesmas regras da API (service-packages.ts): até 3,
 * Básico obrigatório e sem pular nível, nome de 3 a 60, prazo de 1 a 365 dias, revisões de 1 a 10
 * (2 se não mudar), até 10 itens de 2 a 80 caracteres, e o preço não desce do Básico ao Premium.
 * A tela confere antes de mandar; a API confere de novo.
 */
export const PACKAGE_TIERS: readonly PackageTier[] = ['basic', 'standard', 'premium'];

export const PACKAGE_TIER_LABEL: Record<PackageTier, string> = {
  basic: 'Básico',
  standard: 'Padrão',
  premium: 'Premium',
};

export const PACKAGE_NAME_MAX = 60;
export const PACKAGE_DESCRIPTION_MAX = 600;
export const PACKAGE_MAX_DELIVERY_DAYS = 365;
export const PACKAGE_MAX_REVISIONS = 10;
export const PACKAGE_DEFAULT_REVISIONS = 2;
export const MAX_FEATURES = 10;
export const FEATURE_MIN = 2;
export const FEATURE_MAX = 80;
/** Contratação mínima (RN-027): nenhum pacote custa menos, mesmo com o mínimo do painel abaixo. */
export const MIN_PACKAGE_PRICE = 10;

/** Os pacotes do serviço, do Básico ao Premium; [] sem pacotes (ou API anterior). */
export const packagesOf = (s: { packages?: ServicePackage[] }): ServicePackage[] =>
  [...(s.packages ?? [])].sort(
    (a, b) => PACKAGE_TIERS.indexOf(a.tier) - PACKAGE_TIERS.indexOf(b.tier),
  );

/** "1 dia", "5 dias". */
export const daysLabel = (n: number): string => `${n} ${n === 1 ? 'dia' : 'dias'}`;

/** "1 revisão", "3 revisões". */
export const revisionsLabel = (n: number): string => `${n} ${n === 1 ? 'revisão' : 'revisões'}`;

/** Como o item fica gravado: espaços reduzidos e sem espaço nas pontas. */
export const normalizeFeature = (raw: string): string =>
  raw.normalize('NFC').replace(/\s+/g, ' ').trim();

const featureKey = (text: string): string => normalizeFeature(text).toLocaleLowerCase('pt-BR');

/** Por que o item não entra na lista atual; null = entra. */
export function featureProblem(feature: string, current: string[]): string | null {
  const size = [...feature].length;
  if (size < FEATURE_MIN || size > FEATURE_MAX) {
    return `Cada item tem de ${FEATURE_MIN} a ${FEATURE_MAX} caracteres.`;
  }
  if (current.some((f) => featureKey(f) === featureKey(feature))) {
    return `"${feature}" já está na lista.`;
  }
  if (current.length >= MAX_FEATURES) return `No máximo ${MAX_FEATURES} itens por pacote.`;
  return null;
}

/** Os itens de todos os pacotes, sem repetir (ignorando a caixa), na ordem em que aparecem. */
export function allFeatures(packages: readonly ServicePackage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pkg of packages) {
    for (const feature of pkg.features) {
      const key = featureKey(feature);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(feature);
    }
  }
  return out;
}

/** O pacote inclui o item (comparando sem caixa, como a lista de itens). */
export const includes = (pkg: ServicePackage, feature: string): boolean =>
  pkg.features.some((f) => featureKey(f) === featureKey(feature));
