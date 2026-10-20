import { useQueryClient } from '@tanstack/react-query';
import type { AccountContact } from '@escambo/types';
import { Phone } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { BusinessForm } from '../../components/BusinessActions';
import { Button, Field, QueryState } from '../../components/ui';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { ACCOUNT_CONTACT_KEY, formatPhone, useAccountContact } from './contact';

/**
 * Telefone da conta (RF-017): opcional, só o titular vê (não sai no perfil público) e entra na
 * cópia de dados (LGPD). A API valida e guarda em E.164; aqui ele aparece como "(47) 99999-1234".
 * Mudar o telefone é alteração de cadastro: fica bloqueado na suspensão.
 */
export function TelefoneCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const contact = useAccountContact();
  // null = o campo mostra o que está salvo; texto = o que a pessoa está digitando.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function save(phone: string | null): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const next = await api.updatePhone(phone);
      qc.setQueryData<AccountContact>(ACCOUNT_CONTACT_KEY, next);
      setDraft(null);
      toast.success(next.phone ? 'Telefone salvo.' : 'Telefone removido.');
    } catch (er) {
      setError(er instanceof Error ? er.message : 'Erro ao salvar o telefone');
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }

  /** O que o campo mostra: o que está sendo digitado ou, sem edição, o número salvo. */
  const shown = (stored: string | null): string => draft ?? (stored ? formatPhone(stored) : '');

  function submit(e: FormEvent, stored: string | null): void {
    e.preventDefault();
    // Campo vazio apaga; salvar sem mexer regrava o mesmo número (nunca apaga sem querer).
    void save(shown(stored).trim() || null);
  }

  return (
    <section className="card" aria-labelledby="telefone-title" data-testid="telefone-card">
      <div className="card-head">
        <h3 id="telefone-title">
          <Phone size={16} /> Telefone
        </h3>
      </div>
      <QueryState
        isLoading={contact.isLoading}
        error={contact.error}
        data={contact.data}
        onRetry={() => void contact.refetch()}
      >
        {(c) => (
          <BusinessForm
            className="stack"
            onSubmit={(e) => submit(e, c.phone)}
            aria-label="Telefone da conta"
          >
            <p className="muted tiny" id="telefone-dica">
              Opcional. Só você vê este número: ele não aparece no seu perfil público. Use um número
              do Brasil com DDD.
            </p>
            <Field label="Telefone com DDD">
              <input
                ref={inputRef}
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                maxLength={30}
                placeholder="(47) 99999-1234"
                value={shown(c.phone)}
                onChange={(e) => setDraft(e.target.value)}
                aria-invalid={error !== null}
                aria-describedby={error ? 'telefone-erro telefone-dica' : 'telefone-dica'}
              />
            </Field>
            {error && (
              <p className="error" id="telefone-erro" role="alert">
                {error}
              </p>
            )}
            <div className="svc-actions">
              <Button type="submit" disabled={saving}>
                {saving ? 'Salvando…' : 'Salvar telefone'}
              </Button>
              {c.phone && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void save(null)}
                >
                  Remover telefone
                </Button>
              )}
            </div>
          </BusinessForm>
        )}
      </QueryState>
    </section>
  );
}
