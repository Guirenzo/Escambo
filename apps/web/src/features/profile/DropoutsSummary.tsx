import type { DropoutSummary } from '@escambo/types';

const EXPLANATION =
  'Desistência é quando o freelancer encerra uma contratação já aceita; o cliente recebe de volta tudo o que estava em garantia.';

export function DropoutsSummary({
  summary,
  hiring = false,
}: {
  summary?: DropoutSummary;
  hiring?: boolean;
}) {
  if (!summary?.count || (hiring && !summary.alert)) return null;
  if (summary.alert)
    return (
      <span
        className="pill status-cancelled"
        data-testid="dropouts-alert"
        title={EXPLANATION}
        aria-label={EXPLANATION}
      >
        {hiring
          ? `Alerta: este freelancer desistiu de ${summary.count} contratações depois do aceite nos últimos 60 dias.`
          : `Alerta: ${summary.count} desistências depois do aceite nos últimos 60 dias`}
      </span>
    );
  return (
    <span className="muted tiny" data-testid="dropouts">
      {summary.count} {summary.count === 1 ? 'desistência' : 'desistências'} depois do aceite nos
      últimos 60 dias
    </span>
  );
}
