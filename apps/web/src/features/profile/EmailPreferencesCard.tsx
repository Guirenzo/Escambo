import { Mail } from 'lucide-react';
import { useState } from 'react';
import type { EmailFrequency } from '@escambo/types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';

const OPTIONS: { value: EmailFrequency; label: string; hint: string }[] = [
  {
    value: 'instant',
    label: 'A cada evento',
    hint: 'um e-mail na hora para proposta, aceite, entrega, pagamento, prazo, troca e disputa',
  },
  {
    value: 'daily',
    label: 'Resumo diário',
    hint: 'um e-mail por dia, pela manhã, com tudo o que aconteceu desde o resumo anterior',
  },
  {
    value: 'off',
    label: 'Só o essencial',
    hint: 'apenas confirmação de e-mail e redefinição de senha; o resto fica em Notificações',
  },
];

/** Como o usuário quer os e-mails de notificação (ADR 27). O app não muda nada além disso. */
export function EmailPreferencesCard() {
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState<EmailFrequency | null>(null);
  const current = user?.emailFrequency ?? 'instant';

  async function choose(value: EmailFrequency): Promise<void> {
    if (value === current || saving) return;
    setSaving(value);
    try {
      await api.updateEmailPreference(value);
      await refreshUser();
      toast.success(
        value === 'daily'
          ? 'Pronto: um resumo por dia, pela manhã.'
          : value === 'off'
            ? 'Pronto: só e-mails essenciais. As novidades ficam em Notificações.'
            : 'Pronto: um e-mail a cada evento.',
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível salvar');
    } finally {
      setSaving(null);
    }
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
              disabled={saving !== null}
              onChange={() => void choose(o.value)}
            />
            <span>
              <strong>{o.label}</strong>
              <span className="muted tiny">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}
