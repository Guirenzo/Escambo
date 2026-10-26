import { Users } from 'lucide-react';
import type { AdminUsageReport, FinanceGranularity } from '@escambo/types';
import { ColumnChart } from '../../components/charts';
import { QueryState, TableWrap } from '../../components/ui';
import { axisLabel } from '../../lib/format';
import { useAdminUsage } from '../../lib/hooks';
import { bucketFullLabel, GRANULARITY_WORD } from './buckets';

/** O que o leitor de tela ouve no lugar das colunas: o período de mais gente ativa. */
export function activeSummary(r: AdminUsageReport): string {
  const head = `Usuários ativos por ${GRANULARITY_WORD[r.granularity]}`;
  const top = r.series.reduce<AdminUsageReport['series'][number] | null>(
    (a, b) => (!a || b.activeUsers > a.activeUsers ? b : a),
    null,
  );
  return top && top.activeUsers > 0
    ? `${head}: mais ativos em ${bucketFullLabel(top.bucket, r.granularity)}, ${top.activeUsers}.`
    : `${head}: ninguém ativo no período.`;
}

/**
 * Uso da plataforma no período do financeiro (RF-081): cadastros, contratações criadas, concluídas
 * e canceladas e usuários ativos, com todos os baldes (os zerados também). Período já fechado vem
 * do snapshot que o job grava todo dia; o período em curso é calculado na hora. A definição de
 * "ativo" vem da API, a mesma do SQL.
 */
export function UsageReport({
  range,
}: {
  range: { from?: string; to?: string; granularity: FinanceGranularity };
}) {
  const usage = useAdminUsage(range);

  return (
    <div className="fin-usage" data-testid="usage">
      <div className="sub-head">
        <span className="adm-ico blue" aria-hidden="true">
          <Users size={18} />
        </span>
        <div>
          <h4 id="usage-title">Uso da plataforma</h4>
          <p className="muted tiny">Pessoas e contratações no mesmo período do financeiro.</p>
        </div>
      </div>
      <QueryState
        isLoading={usage.isLoading}
        error={usage.error}
        data={usage.data}
        onRetry={() => void usage.refetch()}
      >
        {(r) => {
          const per = GRANULARITY_WORD[r.granularity];
          const fromSnapshot = r.series.filter((b) => b.source === 'snapshot').length;
          return (
            <>
              <div className="fin-kpis">
                <div className="fin-kpi">
                  <span className="kpi-label">Usuários ativos</span>
                  <strong data-testid="usage-active">{r.totals.activeUsers}</strong>
                  <span className="muted tiny">pessoas distintas no período</span>
                </div>
                <div className="fin-kpi">
                  <span className="kpi-label">Novos usuários</span>
                  <strong>{r.totals.newUsers}</strong>
                  <span className="muted tiny">contas criadas</span>
                </div>
                <div className="fin-kpi">
                  <span className="kpi-label">Contratações criadas</span>
                  <strong>{r.totals.newContracts}</strong>
                  <span className="muted tiny">propostas enviadas</span>
                </div>
                <div className="fin-kpi">
                  <span className="kpi-label">Concluídas</span>
                  <strong>{r.totals.completedContracts}</strong>
                  <span className="muted tiny">
                    {r.totals.cancelledContracts} cancelada(s) no período
                  </span>
                </div>
              </div>
              <p className="muted tiny" data-testid="usage-definition">
                {r.activeDefinition}
              </p>

              <div className="viz-block">
                <h4 className="viz-title">Usuários ativos por {per}</h4>
                <ColumnChart
                  data={r.series.map((b, i) => ({
                    key: b.bucket,
                    axis: axisLabel(b.bucket, i === 0),
                    label: bucketFullLabel(b.bucket, r.granularity),
                    values: [b.activeUsers],
                  }))}
                  series={[{ label: 'Ativos', tone: 'blue' }]}
                  summary={activeSummary(r)}
                  format={(v) => `${v} ativo(s)`}
                  tick={(v) => String(v)}
                  integer
                  busy={usage.isPlaceholderData}
                />
              </div>
              <p className="muted tiny" data-testid="usage-source">
                {fromSnapshot === 0
                  ? 'Todos os números foram calculados agora.'
                  : `${fromSnapshot} de ${r.series.length} período(s) vêm do snapshot gravado quando fecharam; o resto foi calculado agora.`}{' '}
                Os ativos de cada {per} não somam: a mesma pessoa conta em cada {per} em que agiu.
              </p>
              <TableWrap label="Tabela de uso da plataforma">
                <table className="table t-list">
                  <caption className="sr-only">
                    Uso da plataforma por {per}: os mesmos números do gráfico, em tabela.
                  </caption>
                  <thead>
                    <tr>
                      <th>Período</th>
                      <th className="right">Ativos</th>
                      <th className="right">Novos usuários</th>
                      <th className="right">Criadas</th>
                      <th className="right">Concluídas</th>
                      <th className="right">Canceladas</th>
                      <th>Fonte</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.series.map((b) => (
                      <tr key={b.bucket}>
                        <td>{bucketFullLabel(b.bucket, r.granularity)}</td>
                        <td className="num" data-label="Ativos">
                          {b.activeUsers}
                        </td>
                        <td className="num" data-label="Novos usuários">
                          {b.newUsers}
                        </td>
                        <td className="num" data-label="Criadas">
                          {b.newContracts}
                        </td>
                        <td className="num" data-label="Concluídas">
                          {b.completedContracts}
                        </td>
                        <td className="num" data-label="Canceladas">
                          {b.cancelledContracts}
                        </td>
                        <td className="muted tiny" data-label="Fonte">
                          {b.source === 'snapshot' ? 'Snapshot' : 'Calculado agora'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
