import type { FinanceGranularity, UsageBucket } from '@escambo/types';
import { QueryState } from '../../components/ui';
import { useAdminUsage } from '../../lib/hooks';
import { bucketFullLabel, bucketLabel, GRANULARITY_WORD } from './buckets';

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
      <h4 id="usage-title">Uso da plataforma</h4>
      <QueryState
        isLoading={usage.isLoading}
        error={usage.error}
        data={usage.data}
        onRetry={() => void usage.refetch()}
      >
        {(r) => {
          const max = Math.max(...r.series.map((b) => b.activeUsers), 1);
          const per = GRANULARITY_WORD[r.granularity];
          const fromSnapshot = r.series.filter((b) => b.source === 'snapshot').length;
          return (
            <>
              <p className="muted tiny" data-testid="usage-definition">
                {r.activeDefinition}
              </p>
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
              <p className="muted tiny" data-testid="usage-source">
                {fromSnapshot === 0
                  ? 'Todos os números foram calculados agora.'
                  : `${fromSnapshot} de ${r.series.length} período(s) vêm do snapshot gravado quando fecharam; o resto foi calculado agora.`}{' '}
                Os ativos de cada {per} não somam: a mesma pessoa conta em cada {per} em que agiu.
              </p>

              <div
                className="fin-chart"
                role="img"
                aria-label={`Usuários ativos por ${per}`}
                aria-describedby="usage-table-caption"
              >
                {r.series.map((b: UsageBucket) => (
                  <div
                    className="fin-bar"
                    key={b.bucket}
                    title={`${bucketFullLabel(b.bucket, r.granularity)}: ${b.activeUsers} ativo(s)`}
                  >
                    <div
                      className="fin-bar-fill usage"
                      style={{ height: `${Math.max(2, (b.activeUsers / max) * 100)}%` }}
                    />
                    <span className="fin-bar-label">{bucketLabel(b.bucket)}</span>
                  </div>
                ))}
              </div>
              <div className="table-wrap">
                <table className="table">
                  <caption id="usage-table-caption" className="sr-only">
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
                        <td className="num">{b.activeUsers}</td>
                        <td className="num">{b.newUsers}</td>
                        <td className="num">{b.newContracts}</td>
                        <td className="num">{b.completedContracts}</td>
                        <td className="num">{b.cancelledContracts}</td>
                        <td className="muted tiny">
                          {b.source === 'snapshot' ? 'Snapshot' : 'Calculado agora'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
