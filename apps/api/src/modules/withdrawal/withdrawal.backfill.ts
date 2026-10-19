import { logger } from '../../config/logger';
import { currentSealPrefix, resealField, type FieldFailure } from '../../utils/field-crypto';
import type { Destination, DestinationColumn } from './withdrawal.fields';
import { withdrawalRepository, type StoredDestinationRow } from './withdrawal.repository';

export interface SealStoredResult {
  /** Saques lidos com algum destino fora da chave atual. */
  checked: number;
  /** Saques regravados com o destino cifrado pela chave atual. */
  sealed: number;
  /** Saques com algum valor cifrado que não decifra: esse valor ficou como estava. */
  unreadable: number;
}

/** Coluna gravada → campo do destino, na ordem do UPDATE. */
const FIELDS: [DestinationColumn, keyof Destination][] = [
  ['pix_key', 'pixKey'],
  ['bank_name', 'bankName'],
  ['bank_agency', 'bankAgency'],
  ['bank_account', 'bankAccount'],
];

/**
 * fields:encrypt (RNF-017): cifra com a chave atual o destino dos saques gravado em texto puro
 * (antes de a chave existir) ou com uma chave antiga (rotação). Em lotes pelo id, e cada saque é um
 * UPDATE só, condicionado ao que foi lido. Idempotente: o que já está com a chave atual nem volta
 * do banco. Valor cifrado que não decifra (chave fora de FIELD_ENCRYPTION_OLD_KEYS, dado
 * corrompido) fica como está e o saque é contado e registrado em warn, sem o valor; os outros
 * campos dele são cifrados mesmo assim. Sem a chave, recusa antes de ler o banco.
 */
export async function sealStoredWithdrawals(batchSize = 200): Promise<SealStoredResult> {
  const prefix = currentSealPrefix();
  if (!prefix) throw new Error('FIELD_ENCRYPTION_KEY não configurada: nada foi cifrado');
  const result: SealStoredResult = { checked: 0, sealed: 0, unreadable: 0 };
  let afterId = 0;
  for (;;) {
    const rows = await withdrawalRepository.listStoredToSeal(afterId, prefix, batchSize);
    for (const row of rows) {
      afterId = row.id;
      result.checked++;
      await sealRow(row, result);
    }
    if (rows.length < batchSize) return result;
  }
}

async function sealRow(row: StoredDestinationRow, result: SealStoredResult): Promise<void> {
  const from: Destination = {
    pixKey: row.pix_key,
    bankName: row.bank_name,
    bankAgency: row.bank_agency,
    bankAccount: row.bank_account,
  };
  const to: Destination = { ...from };
  const failed: { column: DestinationColumn; reason: FieldFailure }[] = [];
  let changed = false;
  for (const [column, field] of FIELDS) {
    const stored = from[field];
    if (stored === null) continue;
    const resealed = resealField(stored);
    if (resealed.status === 'sealed') {
      to[field] = resealed.value;
      changed = true;
    } else if (resealed.status === 'unreadable') {
      failed.push({ column, reason: resealed.reason });
    }
  }
  if (failed.length > 0) {
    result.unreadable++;
    logger.warn(
      { withdrawalId: row.id, failed },
      'Destino de saque cifrado não decifrou com as chaves configuradas: ficou como estava',
    );
  }
  if (changed && (await withdrawalRepository.replaceStoredDestination(row.id, from, to))) {
    result.sealed++;
  }
}
