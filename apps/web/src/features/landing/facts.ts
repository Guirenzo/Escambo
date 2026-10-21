import type { PublicSettings } from '@escambo/types';

/**
 * Regras que a página pública cita (taxa, aprovação automática, saque mínimo, troca ligada). Vêm de
 * GET /api/settings/public, nunca escritas no código: o painel admin muda esses valores. Sem a
 * resposta (carregando ou erro), cada número vira null e o texto cai numa versão sem número.
 */
export interface LandingFacts {
  /** Comissão da plataforma em %: a mesma `platform_fee_percentage` vale para a torna (RN-066). */
  fee: number | null;
  tacitDays: number | null;
  minWithdrawal: number | null;
  /** Troca de serviços ligada no painel. Sem resposta, vale o padrão do produto (ligada). */
  barter: boolean;
}

const valid = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

export function factsFrom(settings: PublicSettings | undefined): LandingFacts {
  return {
    fee: valid(settings?.platformFeePercentage),
    tacitDays: valid(settings?.tacitApprovalDays),
    minWithdrawal: valid(settings?.minWithdrawalAmount),
    barter: settings?.barterEnabled ?? true,
  };
}

/** "15%" ou "12,5%". */
export const percent = (n: number): string =>
  `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

/** "R$ 1.200" para valor inteiro, "R$ 61,50" com centavos. */
export function money(n: number): string {
  const cents = Math.round(n * 100) % 100 !== 0;
  return n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

/** "1 dia", "5 dias". */
export const days = (n: number): string => `${n} ${n === 1 ? 'dia' : 'dias'}`;

/** Os valores do exemplo de troca (os mesmos da captura de Trocas do README). */
export const TRADE_EXAMPLE = { offered: 800, requested: 1200 } as const;

/**
 * A conta do exemplo, como a API faz (RN-066): a torna é a diferença; a taxa vigente incide só
 * sobre ela, arredondada ao centavo, e sai de quem recebe a torna. Sem a taxa, só a torna.
 */
export function tradeExample(fee: number | null): {
  torna: number;
  feeValue: number | null;
  net: number | null;
} {
  const { torna, feeValue, net } = tornaQuote(TRADE_EXAMPLE.offered, TRADE_EXAMPLE.requested, fee);
  return { torna, feeValue, net };
}

/**
 * Valor digitado em reais, do jeito que a pessoa escreve: "1200", "1.200", "1.200,50",
 * "R$ 800", "99,9" ou "99.90". Vazio, negativo ou sem número vira null.
 */
export function parseMoney(raw: string): number | null {
  let s = raw.replace(/R\$|\s/gi, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const comma = s.lastIndexOf(',');
  if (comma >= 0) {
    // Vírgula é sempre o decimal; os pontos antes dela separam milhares.
    s = `${s.slice(0, comma).replace(/[.,]/g, '')}.${s.slice(comma + 1).replace(/[.,]/g, '')}`;
  } else {
    // Só pontos: "1.200" e "12.500.000" separam milhares; "99.9" e "99.90" são decimais.
    // Sem ponto nenhum, o número fica como está ("1200" é mil e duzentos).
    const parts = s.split('.');
    const thousands = parts.slice(1).every((p) => p.length === 3);
    s = thousands
      ? parts.join('')
      : `${parts.slice(0, -1).join('')}.${parts[parts.length - 1] ?? ''}`;
  }
  const n = Number(s.startsWith('.') ? `0${s}` : s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** Quem completa a diferença numa troca, do ponto de vista de quem simula. */
export type TornaPayer = 'you' | 'other' | 'none';

export interface TornaQuote {
  torna: number;
  payer: TornaPayer;
  /** Taxa da plataforma sobre a torna; null quando a taxa ainda não chegou da API. */
  feeValue: number | null;
  /** O que chega a quem recebe a torna; null sem a taxa. */
  net: number | null;
}

/**
 * A torna de uma troca (RN-066): a diferença entre o serviço que você quer e o que você oferece.
 * Quem recebe o serviço mais caro paga; a taxa vigente incide só sobre a torna, arredondada ao
 * centavo, e sai de quem recebe. Troca equilibrada não tem torna nem taxa.
 */
export function tornaQuote(offered: number, requested: number, fee: number | null): TornaQuote {
  const torna = Math.round(Math.abs(requested - offered) * 100) / 100;
  const payer: TornaPayer = torna === 0 ? 'none' : requested > offered ? 'you' : 'other';
  if (fee === null) return { torna, payer, feeValue: null, net: null };
  const feeValue = Math.round(torna * fee) / 100;
  return { torna, payer, feeValue, net: Math.round((torna - feeValue) * 100) / 100 };
}
