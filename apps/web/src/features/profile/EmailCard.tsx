import { useQueryClient } from '@tanstack/react-query';
import type { AccountContact } from '@escambo/types';
import { AtSign } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { BusinessForm } from '../../components/BusinessActions';
import { Button, Field, QueryState } from '../../components/ui';
import { api } from '../../lib/api';
import { dtm } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { ACCOUNT_CONTACT_KEY, useAccountContact } from './contact';

/**
 * Troca de e-mail (RF-017). A senha atual confirma que é o titular; o endereço novo só vale depois
 * que o link enviado a ele é aberto, e até lá o acesso segue pelo atual, que recebe um aviso.
 * Pedir a troca muda o cadastro e fica bloqueado na suspensão; desistir só protege a conta e vale
 * sempre. A resposta da API é a mesma se o endereço já tiver conta: o cartão não sabe e não diz.
 */
export function EmailCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const contact = useAccountContact();
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** O campo que precisa de correção: só ele fica marcado como inválido (aria-invalid). */
  const [badField, setBadField] = useState<HTMLInputElement | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  function patch(change: Partial<AccountContact>): void {
    qc.setQueryData<AccountContact>(ACCOUNT_CONTACT_KEY, (c) => (c ? { ...c, ...change } : c));
  }

  /** Mostra o erro e leva o foco ao campo que precisa ser corrigido. */
  function fail(message: string, field: HTMLInputElement | null): void {
    setError(message);
    setBadField(field);
    field?.focus();
  }

  async function submit(e: FormEvent, current: string): Promise<void> {
    e.preventDefault();
    const target = newEmail.trim();
    if (target.toLowerCase() === current.toLowerCase()) {
      return fail('Este já é o e-mail da sua conta', emailRef.current);
    }
    setSaving(true);
    setError(null);
    setBadField(null);
    try {
      const pending = await api.changeEmail({ currentPassword: password, newEmail: target });
      patch({ pendingEmail: pending });
      setNewEmail('');
      setPassword('');
      toast.success('Pedido enviado. Confirme pelo link que mandamos ao novo endereço.');
    } catch (er) {
      const code = (er as { code?: unknown }).code;
      fail(
        er instanceof Error ? er.message : 'Erro ao pedir a troca de e-mail',
        code === 'wrong_password' ? passwordRef.current : emailRef.current,
      );
    } finally {
      setSaving(false);
    }
  }

  async function cancel(): Promise<void> {
    setCancelling(true);
    try {
      await api.cancelEmailChange();
      patch({ pendingEmail: null });
      toast.success('Troca de e-mail cancelada. O link enviado não vale mais.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao cancelar a troca');
    } finally {
      setCancelling(false);
    }
  }

  const invalid = error !== null;
  return (
    <section className="card" aria-labelledby="email-title" data-testid="email-card">
      <div className="card-head">
        <h3 id="email-title">
          <AtSign size={16} /> E-mail
        </h3>
      </div>
      <QueryState
        isLoading={contact.isLoading}
        error={contact.error}
        data={contact.data}
        onRetry={() => void contact.refetch()}
      >
        {(c) => (
          <div className="stack">
            <p className="muted tiny" data-testid="email-atual">
              E-mail de acesso: <strong>{c.email}</strong>{' '}
              {c.emailVerified ? '(confirmado)' : '(ainda não confirmado)'}
            </p>
            {c.pendingEmail && (
              <div className="notice" role="status" data-testid="email-pendente">
                <span>
                  Confirme no novo endereço: enviamos um link para{' '}
                  <strong>{c.pendingEmail.email}</strong>, válido até{' '}
                  {dtm(c.pendingEmail.expiresAt)}. Até lá, você entra com o e-mail atual.
                </span>
                <Button
                  type="button"
                  variant="mini"
                  onClick={() => void cancel()}
                  disabled={cancelling}
                >
                  {cancelling ? 'Cancelando…' : 'Cancelar troca'}
                </Button>
              </div>
            )}
            <p className="muted tiny">
              O endereço novo só vale depois que você abrir o link que enviamos a ele, e o atual
              recebe um aviso. Se o link não chegar, confira o endereço: ele pode já estar em uso.
              Trocar ou redefinir a senha cancela o pedido.
            </p>
            <BusinessForm
              className="stack"
              onSubmit={(e) => void submit(e, c.email)}
              aria-label="Trocar e-mail"
            >
              <Field label="Novo e-mail">
                <input
                  ref={emailRef}
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  required
                  maxLength={255}
                  autoComplete="email"
                  placeholder="voce@exemplo.com"
                  aria-describedby={invalid ? 'email-erro' : undefined}
                  aria-invalid={badField !== null && badField === emailRef.current}
                />
              </Field>
              <Field label="Senha atual">
                <input
                  ref={passwordRef}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  aria-describedby={invalid ? 'email-erro' : undefined}
                  aria-invalid={badField !== null && badField === passwordRef.current}
                />
              </Field>
              {error && (
                <p className="error" id="email-erro" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={saving}>
                {saving ? 'Enviando…' : 'Trocar e-mail'}
              </Button>
            </BusinessForm>
          </div>
        )}
      </QueryState>
    </section>
  );
}
