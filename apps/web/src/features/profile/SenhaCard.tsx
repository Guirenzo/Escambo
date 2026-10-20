import { KeyRound } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Button, Field } from '../../components/ui';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';

/**
 * Troca de senha com login (RF-017). Não usa o formulário de negócio: é segurança da conta e vale
 * também durante a suspensão. A API encerra as outras sessões; esta segue com o par novo, que o
 * cliente HTTP já guarda.
 */
export function SenhaCard() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** O campo que precisa de correção: só ele fica marcado como inválido (aria-invalid). */
  const [badField, setBadField] = useState<HTMLInputElement | null>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  /** Mostra o erro e leva o foco ao campo que precisa ser corrigido. */
  function fail(message: string, field: HTMLInputElement | null): void {
    setError(message);
    setBadField(field);
    field?.focus();
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (next !== confirm) return fail('As senhas não conferem', confirmRef.current);
    if (next === current) {
      return fail('A nova senha precisa ser diferente da atual', nextRef.current);
    }
    setSaving(true);
    setError(null);
    setBadField(null);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Senha alterada. As outras sessões foram encerradas.');
    } catch (er) {
      const code = (er as { code?: unknown }).code;
      fail(
        er instanceof Error ? er.message : 'Erro ao trocar a senha',
        code === 'wrong_password' ? currentRef.current : null,
      );
    } finally {
      setSaving(false);
    }
  }

  const invalid = error !== null;
  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <KeyRound size={16} /> Senha
        </h3>
      </div>
      <p className="muted tiny">
        Ao trocar, as outras sessões abertas são encerradas e esta continua. Você recebe um aviso
        por e-mail.
      </p>
      <form className="stack" onSubmit={(e) => void submit(e)} aria-label="Trocar senha">
        <Field label="Senha atual">
          <input
            ref={currentRef}
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoComplete="current-password"
            aria-describedby={invalid ? 'senha-erro' : undefined}
            aria-invalid={badField !== null && badField === currentRef.current}
          />
        </Field>
        <Field label="Nova senha">
          <input
            ref={nextRef}
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="mínimo 8 caracteres"
            aria-describedby={invalid ? 'senha-erro' : undefined}
            aria-invalid={badField !== null && badField === nextRef.current}
          />
        </Field>
        <Field label="Confirmar nova senha">
          <input
            ref={confirmRef}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            aria-describedby={invalid ? 'senha-erro' : undefined}
            aria-invalid={badField !== null && badField === confirmRef.current}
          />
        </Field>
        {error && (
          <p className="error" id="senha-erro" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={saving}>
          {saving ? 'Salvando…' : 'Trocar senha'}
        </Button>
      </form>
    </section>
  );
}
