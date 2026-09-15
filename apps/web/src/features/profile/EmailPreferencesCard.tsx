import { Clock, Mail } from 'lucide-react';
import { useState } from 'react';
import type { EmailFrequency, UpdateEmailPreferenceRequest } from '@escambo/types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DIGEST_HOURS, digestHourLabel } from '../../lib/format';
import { useToast } from '../../lib/toast';

const OPTIONS: { value: EmailFrequency; label: string; hint: (hour: string) => string }[] = [
  {
    value: 'instant',
    label: 'A cada evento',
    hint: () =>
      'um e-mail na hora para proposta, aceite, entrega, pagamento, prazo, troca e disputa',
  },
  {
    value: 'daily',
    label: 'Resumo diário',
    hint: (hour) =>
      `um e-mail por dia, às ${hour}, com tudo o que aconteceu desde o resumo anterior`,
  },
  {
    value: 'off',
    label: 'Só o essencial',
    hint: () => 'apenas confirmação de e-mail e redefinição de senha; o resto fica em Notificações',
  },
];

/**
 * Como o usuário quer os e-mails de notificação (ADR 27) e a hora do resumo do dia (ADR 42), que
 * vale para o e-mail diário e para as buscas salvas com alerta diário. O app não muda além disso.
 */
export function EmailPreferencesCard() {
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const current = user?.emailFrequency ?? 'instant';
  const hour = user?.digestHour ?? 8;

  async function save(change: UpdateEmailPreferenceRequest, done: string): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await api.updateEmailPreference(change);
      await refreshUser();
      toast.success(done);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível salvar');
    } finally {
      setSaving(false);
    }
  }

  function choose(value: EmailFrequency): void {
    if (value === current) return;
    void save(
      { emailFrequency: value },
      value === 'daily'
        ? `Pronto: um resumo por dia, às ${digestHourLabel(hour)}.`
        : value === 'off'
          ? 'Pronto: só e-mails essenciais. As novidades ficam em Notificações.'
          : 'Pronto: um e-mail a cada evento.',
    );
  }

  function chooseHour(value: number): void {
    if (value === hour) return;
    void save({ digestHour: value }, `Pronto: seu resumo do dia sai às ${digestHourLabel(value)}.`);
  }

  return (
    <section className="card wide" aria-labelledby="email-pref-title" data-testid="email-prefs">
      <div className="card-head">
        <h3 id="email-pref-title">
          <Mail size={16} /> E-mails do Escambo
        </h3>
        <span className="muted tiny">as notificações no app continuam iguais</span>
      </div>
      <fieldset className="pref-list">
        <legend className="sr-only">Frequência dos e-mails de notificação</legend>
        {OPTIONS.map((o) => (
          <label key={o.value} className={current === o.value ? 'on' : ''}>
            <input
              type="radio"
              name="emailFrequency"
              value={o.value}
              checked={current === o.value}
              disabled={saving}
              onChange={() => choose(o.value)}
            />
            <span>
              <strong>{o.label}</strong>
              <span className="muted tiny">{o.hint(digestHourLabel(hour))}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="pref-hour">
        <span className="pref-hour-ico" aria-hidden="true">
          <Clock size={16} />
        </span>
        <label className="pref-hour-field">
          <span>Horário do resumo do dia</span>
          <select
            value={hour}
            disabled={saving}
            aria-describedby="digest-hour-hint"
            onChange={(e) => chooseHour(Number(e.target.value))}
          >
            {DIGEST_HOURS.map((h) => (
              <option key={h} value={h}>
                {digestHourLabel(h)}
              </option>
            ))}
          </select>
        </label>
        <span id="digest-hour-hint" className="muted tiny">
          Horário de Brasília. Vale para o resumo por e-mail e para as buscas salvas com alerta
          diário.
        </span>
      </div>
    </section>
  );
}
