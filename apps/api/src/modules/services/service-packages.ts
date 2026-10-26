import type { PackageTier, ServicePackage } from '@escambo/types';
import { z } from 'zod';

/**
 * Pacotes do serviço (RF-086, RN-068): Básico, Padrão e Premium, cada um com preço, prazo,
 * revisões e itens próprios. O Básico é obrigatório e os níveis não pulam (o Premium exige o
 * Padrão); a lista sai sempre do Básico ao Premium.
 */
export const PACKAGE_TIERS = [
  'basic',
  'standard',
  'premium',
] as const satisfies readonly PackageTier[];

/** Os nomes dos níveis como as mensagens e a tela mostram. */
export const PACKAGE_TIER_LABEL: Record<PackageTier, string> = {
  basic: 'Básico',
  standard: 'Padrão',
  premium: 'Premium',
};

export const PACKAGE_NAME_MIN = 3;
export const PACKAGE_NAME_MAX = 60;
export const PACKAGE_DESCRIPTION_MAX = 600;
export const PACKAGE_MAX_DELIVERY_DAYS = 365;
/** Revisões sem custo por entrega (RN-023): de 1 a 10, 2 se não vier. Não há "ilimitado". */
export const PACKAGE_MIN_REVISIONS = 1;
export const PACKAGE_MAX_REVISIONS = 10;
export const PACKAGE_DEFAULT_REVISIONS = 2;
export const MAX_PACKAGE_FEATURES = 10;
export const FEATURE_MIN = 2;
export const FEATURE_MAX = 80;
/**
 * Teto de DECIMAL(10,2), a coluna do preço do pacote e da contratação. O mesmo número do
 * MAX_CONTRACT_AMOUNT das contratações, repetido aqui: um módulo não importa o schema do outro.
 */
export const MAX_PACKAGE_PRICE = 99_999_999.99;
/** Contratação mínima (RN-027): nenhum pacote custa menos, mesmo com o mínimo do painel abaixo. */
export const MIN_CONTRACT_PRICE = 10;

const tierOrder = (tier: PackageTier): number => PACKAGE_TIERS.indexOf(tier);

/** Chave de comparação dos itens: sem caixa e sem espaço sobrando ("Logo  vetorial" = "logo vetorial"). */
const featureKey = (text: string): string =>
  text.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR');

const featuresSchema = z
  .array(
    z
      .string({ error: 'Cada item incluso é um texto' })
      .transform((text) => text.normalize('NFC').replace(/\s+/g, ' ').trim())
      .pipe(
        z
          .string()
          .min(FEATURE_MIN, `Cada item incluso tem de ${FEATURE_MIN} a ${FEATURE_MAX} caracteres`)
          .max(FEATURE_MAX, `Cada item incluso tem de ${FEATURE_MIN} a ${FEATURE_MAX} caracteres`),
      ),
    { error: 'Envie os itens inclusos como lista de textos' },
  )
  .max(MAX_PACKAGE_FEATURES, `No máximo ${MAX_PACKAGE_FEATURES} itens inclusos por pacote`)
  .superRefine((features, ctx) => {
    const seen = new Set<string>();
    features.forEach((feature, i) => {
      const key = featureKey(feature);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: [i], message: `Item repetido: "${feature}"` });
      }
      seen.add(key);
    });
  });

/** Um pacote como a API aceita no cadastro e na edição do serviço. Chave desconhecida é 422. */
export const packageSchema = z
  .object({
    tier: z.enum(PACKAGE_TIERS, { error: 'Nível do pacote: basic, standard ou premium' }),
    name: z
      .string({ error: 'Dê um nome ao pacote' })
      .trim()
      .min(
        PACKAGE_NAME_MIN,
        `O nome do pacote tem de ${PACKAGE_NAME_MIN} a ${PACKAGE_NAME_MAX} caracteres`,
      )
      .max(
        PACKAGE_NAME_MAX,
        `O nome do pacote tem de ${PACKAGE_NAME_MIN} a ${PACKAGE_NAME_MAX} caracteres`,
      ),
    // Vazio vale como sem descrição.
    description: z
      .string()
      .trim()
      .max(
        PACKAGE_DESCRIPTION_MAX,
        `A descrição do pacote vai até ${PACKAGE_DESCRIPTION_MAX} caracteres`,
      )
      .nullable()
      .optional()
      .transform((text) => (text ? text : null)),
    price: z
      .number({ error: 'O preço do pacote é um número' })
      .positive('O preço do pacote precisa ser maior que zero')
      .multipleOf(0.01, 'O preço vai até os centavos: no máximo duas casas decimais')
      .max(MAX_PACKAGE_PRICE, 'O valor máximo é R$ 99.999.999,99'),
    deliveryDays: z
      .number({ error: 'O prazo do pacote é um número de dias' })
      .int('O prazo do pacote é um número inteiro de dias')
      .min(1, 'O prazo do pacote é de pelo menos 1 dia')
      .max(
        PACKAGE_MAX_DELIVERY_DAYS,
        `O prazo do pacote vai até ${PACKAGE_MAX_DELIVERY_DAYS} dias`,
      ),
    revisions: z
      .number({ error: 'As revisões do pacote são um número' })
      .int('As revisões do pacote são um número inteiro')
      .min(
        PACKAGE_MIN_REVISIONS,
        `Cada pacote inclui de ${PACKAGE_MIN_REVISIONS} a ${PACKAGE_MAX_REVISIONS} revisões (RN-023)`,
      )
      .max(
        PACKAGE_MAX_REVISIONS,
        `Cada pacote inclui de ${PACKAGE_MIN_REVISIONS} a ${PACKAGE_MAX_REVISIONS} revisões (RN-023)`,
      )
      .default(PACKAGE_DEFAULT_REVISIONS),
    features: featuresSchema.default([]),
  })
  .strict();

/**
 * A lista de pacotes do serviço (RN-068): no máximo 3, um por nível, com o Básico e sem pular
 * nível. Sai do Básico ao Premium, seja qual for a ordem enviada. Lista vazia tira os pacotes. O
 * preço mínimo e a ordem dos preços dependem do painel e são conferidos no service (422 com código).
 */
export const packagesSchema = z
  .array(packageSchema, { error: 'Envie os pacotes como lista' })
  .max(PACKAGE_TIERS.length, `No máximo ${PACKAGE_TIERS.length} pacotes por serviço (RN-068)`)
  .superRefine((pkgs, ctx) => {
    if (pkgs.length === 0) return;
    const seen = new Set<PackageTier>();
    pkgs.forEach((pkg, i) => {
      if (seen.has(pkg.tier)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'tier'],
          message: `Pacote ${PACKAGE_TIER_LABEL[pkg.tier]} repetido: um pacote por nível`,
        });
      }
      seen.add(pkg.tier);
    });
    if (!seen.has('basic')) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'O pacote Básico é obrigatório (RN-068)',
      });
    }
    if (seen.has('premium') && !seen.has('standard')) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'O pacote Premium exige o Padrão: os níveis não pulam (RN-068)',
      });
    }
  })
  .transform((pkgs) => [...pkgs].sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier)));
export type PackageInput = z.infer<typeof packageSchema>;

/**
 * O que a busca e a ordenação leem do serviço com pacotes (ADR 69): o preço e o prazo do Básico,
 * gravados em services.price e services.delivery_days. O filtro de preço passa a valer como "a
 * partir de", e os índices de cobertura da listagem (0040) continuam servindo.
 */
export function derivePackageListing(pkgs: readonly ServicePackage[]): {
  price: number;
  deliveryDays: number;
} {
  const basic = pkgs.find((p) => p.tier === 'basic') ?? pkgs[0];
  if (!basic) throw new Error('derivePackageListing: serviço sem pacotes');
  return { price: basic.price, deliveryDays: basic.deliveryDays };
}

/** Os itens gravados em JSON: lista de textos, nunca null (texto inválido vira lista vazia). */
export function parseFeatures(raw: unknown): string[] {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : [];
}

/** A linha de service_packages como a API devolve. */
export function packageFromRow(row: {
  tier: string;
  name: string;
  description: string | null;
  price: string | number;
  delivery_days: number;
  revisions: number;
  features: unknown;
}): ServicePackage {
  return {
    tier: row.tier as PackageTier,
    name: row.name,
    description: row.description ?? null,
    price: Number(row.price),
    deliveryDays: Number(row.delivery_days),
    revisions: Number(row.revisions),
    features: parseFeatures(row.features),
  };
}

/**
 * A cópia do pacote guardada na contratação (package_snapshot), lida de volta: o driver pode
 * devolver o JSON já lido ou como texto. Snapshot que não é um pacote vale como sem pacote.
 */
export function packageFromSnapshot(raw: unknown): ServicePackage | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!PACKAGE_TIERS.includes(v.tier as PackageTier) || typeof v.name !== 'string') return null;
  const price = Number(v.price);
  const deliveryDays = Number(v.deliveryDays);
  const revisions = Number(v.revisions);
  if (![price, deliveryDays, revisions].every(Number.isFinite)) return null;
  return {
    tier: v.tier as PackageTier,
    name: v.name,
    description: typeof v.description === 'string' ? v.description : null,
    price,
    deliveryDays,
    revisions,
    features: parseFeatures(v.features),
  };
}
