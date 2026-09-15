import type { SavedSearchAlertFrequency } from '@escambo/types';

/** As frequências do alerta de busca salva (ADR 37), na ordem em que aparecem na tela. */
export const ALERT_FREQUENCY_OPTIONS: {
  value: SavedSearchAlertFrequency;
  label: string;
  hint: string;
}[] = [
  {
    value: 'instant',
    label: 'Na hora',
    hint: 'assim que aparecer serviço novo, em poucos minutos',
  },
  {
    value: 'hourly',
    label: 'De hora em hora',
    hint: 'no máximo um aviso por hora com o que apareceu',
  },
  {
    value: 'daily',
    label: 'Uma vez por dia',
    hint: 'um resumo pela manhã com os serviços novos do dia',
  },
];

/** A mesma frequência que a API usa quando ninguém escolhe (e a das buscas antigas). */
export const DEFAULT_ALERT_FREQUENCY: SavedSearchAlertFrequency = 'hourly';

/** Rótulo curto da frequência, usado no título do sino da busca salva. */
export const alertFrequencyLabel = (f: SavedSearchAlertFrequency): string =>
  ALERT_FREQUENCY_OPTIONS.find((o) => o.value === f)?.label ?? 'De hora em hora';

/** O que a pessoa lê ao ligar o alerta, conforme a frequência escolhida. */
export function alertNotice(f: SavedSearchAlertFrequency): string {
  switch (f) {
    case 'instant':
      return 'Avisamos assim que aparecer serviço novo.';
    case 'daily':
      return 'Mandamos um resumo por dia, pela manhã, quando aparecer serviço novo.';
    default:
      return 'Avisamos no máximo uma vez por hora quando aparecer serviço novo.';
  }
}
