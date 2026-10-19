import { logger } from '../../config/logger';
import {
  FIELD_UNAVAILABLE,
  openField,
  sealNullableField,
  type FieldFailure,
} from '../../utils/field-crypto';

/**
 * Destino do saque cifrado em repouso (RNF-017): a chave PIX e os dados bancários. O repository
 * cifra no INSERT e decifra o que lê, e a cópia de dados (LGPD) decifra o que exporta; acima disso
 * só circula o texto. Sem FIELD_ENCRYPTION_KEY grava em texto puro, como antes.
 */
export const DESTINATION_COLUMNS = ['pix_key', 'bank_name', 'bank_agency', 'bank_account'] as const;
export type DestinationColumn = (typeof DESTINATION_COLUMNS)[number];

export interface Destination {
  pixKey: string | null;
  bankName: string | null;
  bankAgency: string | null;
  bankAccount: string | null;
}

/** O destino como vai para o banco: cifrado com a chave atual (ou como veio, sem chave). */
export function sealDestination(d: Destination): Destination {
  return {
    pixKey: sealNullableField(d.pixKey),
    bankName: sealNullableField(d.bankName),
    bankAgency: sealNullableField(d.bankAgency),
    bankAccount: sealNullableField(d.bankAccount),
  };
}

/**
 * Decifra o destino de uma linha de saque lida do banco (devolve uma cópia; o que não é destino
 * passa igual). Linha antiga em texto puro volta como está. Valor cifrado que não decifra (chave
 * errada, dado corrompido) vira "[indisponível]" — a listagem não cai — e gera um warn com o saque,
 * a coluna e o motivo, nunca o valor.
 */
export function openDestination<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  const failed: { column: DestinationColumn; reason: FieldFailure }[] = [];
  for (const column of DESTINATION_COLUMNS) {
    const stored = out[column];
    if (typeof stored !== 'string') continue;
    const opened = openField(stored);
    if (opened.ok) {
      out[column] = opened.value;
    } else {
      out[column] = FIELD_UNAVAILABLE;
      failed.push({ column, reason: opened.reason });
    }
  }
  if (failed.length > 0) {
    logger.warn(
      { withdrawalId: out.id, failed },
      'Destino de saque cifrado não decifrou (chave errada ou dado corrompido): vai como [indisponível]',
    );
  }
  return out as T;
}
