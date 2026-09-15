import type { SavedSearchAlertFrequency } from '@escambo/types';
import { digestHourLabel } from '../../lib/format';

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
    hint: 'um resumo com os serviços novos do dia, na hora do seu resumo (Perfil)',
  },
];

/** A mesma frequência que a API usa quando ninguém escolhe (e a das buscas antigas). */
export const DEFAULT_ALERT_FREQUENCY: SavedSearchAlertFrequency = 'hourly';

/** Rótulo curto da frequência, usado no título do sino da busca salva. */
export const alertFrequencyLabel = (f: SavedSearchAlertFrequency): string =>
  ALERT_FREQUENCY_OPTIONS.find((o) => o.value === f)?.label ?? 'De hora em hora';

/** O que a pessoa lê ao ligar o alerta, conforme a frequência e a hora do resumo do dia (ADR 42). */
export function alertNotice(f: SavedSearchAlertFrequency, digestHour?: number): string {
  switch (f) {
    case 'instant':
      return 'Avisamos assim que aparecer serviço novo.';
    case 'daily':
      return digestHour === undefined
        ? 'Mandamos um resumo por dia, na hora do seu resumo, quando aparecer serviço novo.'
        : `Mandamos um resumo por dia, às ${digestHourLabel(digestHour)}, quando aparecer serviço novo.`;
    default:
      return 'Avisamos no máximo uma vez por hora quando aparecer serviço novo.';
  }
}
