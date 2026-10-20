import type { WalletEarnings } from '@escambo/types';
import { clock } from '../../utils/clock';
import { dayIn } from '../../utils/timezone';
import { userZone } from '../auth/user-zone';
import {
  resolveEarningsPeriod,
  summarizeEarnings,
  type EarningEntry,
  type EarningsQuery,
} from './wallet.earnings';
import { earningsRepository, type EarningTxRow } from './wallet.earnings.repository';
import { periodRange } from './wallet.period';

const toEntry = (r: EarningTxRow): EarningEntry => ({
  id: r.id,
  amount: Number(r.amount),
  reason: r.reason as EarningEntry['reason'],
  contractId: r.contract_id,
  createdAt: new Date(r.created_at),
});

export const earningsService = {
  /**
   * Ganhos do usuário por período (RF-082), no fuso da conta (ADR 46): o "hoje" do padrão, os
   * limites de cada dia e o período de cada barra são os de quem lê.
   */
  async report(userId: number, q: EarningsQuery): Promise<WalletEarnings> {
    const zone = await userZone(userId);
    const { from, to, keys } = resolveEarningsPeriod(q, dayIn(zone, clock.now()));
    const range = await periodRange({ from, to }, async () => zone);
    const [rows, credits, hasEarnings] = await Promise.all([
      earningsRepository.moneyEntries(userId, range),
      earningsRepository.creditTotals(userId, range),
      earningsRepository.hasEarnings(userId),
    ]);
    const { series, totals } = summarizeEarnings(rows.map(toEntry), zone, q.granularity, keys);
    return {
      from,
      to,
      granularity: q.granularity,
      timezone: zone,
      hasEarnings,
      totals,
      series,
      credits,
    };
  },
};
