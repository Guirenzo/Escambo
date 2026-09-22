import { Clock } from 'lucide-react';
import { useState } from 'react';
import type { BrazilTimezone, PublicUser } from '@escambo/types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { timezoneLabel } from '../../lib/timezones';
import { useToast } from '../../lib/toast';

/**
 * Sugestão única de fuso (ADR 51): a conta nunca escolheu fuso e o aparelho está em outro fuso do
 * Brasil. As duas respostas gravam a escolha na conta, então a pergunta não volta em nenhum
 * aparelho. Sem fuso detectado, ou com o mesmo da conta, não aparece.
 */
export function TimezoneBanner({ user, detected }: { user: PublicUser; detected: BrazilTimezone }) {
  const { refreshUser } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const here = timezoneLabel(detected);
  const current = timezoneLabel(user.timezone);
  const isFreelancer = user.role === 'freelancer';

  async function choose(zone: BrazilTimezone): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await api.updateEmailPreference({ timezone: zone });
      await refreshUser();
      toast.success(
        zone === detected
          ? `Pronto: sua conta agora usa o horário de ${here}.`
          : `Pronto: sua conta continua no horário de ${timezoneLabel(zone)}.`,
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível salvar o fuso');
      setSaving(false);
    }
  }

  return (
    <div
      className="verify-banner tz-banner"
      role="region"
      aria-label="Sugestão de fuso horário"
      data-testid="timezone-banner"
    >
      <Clock size={16} aria-hidden="true" />
      <span>
        Seu aparelho está no horário de <strong>{here}</strong>, e sua conta no de {current}. Usar o
        horário de {here} no resumo por e-mail
        {isFreelancer ? ', nos avisos e na sua agenda de atendimento' : ' e nos avisos'}?
      </span>
      <span className="tz-actions">
        <button
          type="button"
          className="link"
          disabled={saving}
          onClick={() => void choose(detected)}
        >
          Usar horário de {here}
        </button>
        <button
          type="button"
          className="link"
          disabled={saving}
          onClick={() => void choose(user.timezone)}
        >
          Manter {current}
        </button>
      </span>
    </div>
  );
}
