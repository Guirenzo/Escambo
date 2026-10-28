import type { PublicUser } from '@escambo/types';
import { MailWarning } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/errors';
import { useToast } from '../lib/toast';
import { BusinessModal } from './BusinessActions';
import { Button } from './ui';

/**
 * Ações críticas sem e-mail confirmado (RF-006, RN-004): contratar, publicar serviço, depositar,
 * propor ou aceitar troca, impulsionar e sacar. A regra é da API (403 `email_not_verified`); aqui
 * o botão continua à mostra e, em vez de agir, abre o aviso com o reenvio do link. Quando a API
 * recusa com a tela desatualizada, o AuthProvider marca a conta como não confirmada e os avisos
 * aparecem no lugar do formulário.
 */

/**
 * Quem está logado. Fora do AuthProvider (um componente montado sozinho), ninguém: o aviso é da
 * tela, e quem decide é a API.
 */
function useSessionUser(): PublicUser | null {
  try {
    return useAuth().user;
  } catch {
    return null;
  }
}

/** O e-mail da conta está confirmado? Sem sessão carregada a tela não trava nada: a API decide. */
export function useEmailVerified(): boolean {
  return useSessionUser()?.emailVerified ?? true;
}

/** Reenvia o link de confirmação e avisa o resultado (o lembrete do topo, a Carteira e o aviso). */
export function useResendVerification(): { resend: () => Promise<void>; sending: boolean } {
  const user = useSessionUser();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const email = user?.email;
  const resend = useCallback(async (): Promise<void> => {
    setSending(true);
    try {
      await api.resendVerification();
      toast.success(`Link reenviado para ${email ?? 'seu e-mail'}.`);
    } catch (er) {
      toast.error(errorMessage(er, 'Não foi possível reenviar'));
    } finally {
      setSending(false);
    }
  }, [email, toast]);
  return { resend, sending };
}

/**
 * O aviso no lugar da ação: "Confirme seu e-mail para contratar." com o endereço e o reenvio.
 * `action` completa a frase ("contratar", "publicar um serviço", "aceitar a troca").
 */
export function VerifyEmailNotice({ action }: { action: string }) {
  const user = useSessionUser();
  const { resend, sending } = useResendVerification();
  return (
    <div className="verify-notice" role="status" data-testid="verify-email-notice">
      <p className="verify-notice-msg">
        <MailWarning size={18} aria-hidden="true" />
        <span>
          <strong>Confirme seu e-mail para {action}.</strong> Enviamos um link para{' '}
          <strong>{user?.email ?? 'o seu e-mail'}</strong>: abra a mensagem e toque no link. Depois
          disso, é só voltar aqui.
        </span>
      </p>
      <Button type="button" variant="secondary" onClick={() => void resend()} loading={sending}>
        {sending ? 'Reenviando…' : 'Reenviar e-mail'}
      </Button>
    </div>
  );
}

/**
 * O diálogo que o botão abre no lugar do formulário ou da ação. É um diálogo de negócio: se a conta
 * for suspensa com ele aberto, fecha como os outros (a suspensão já bloqueia tudo).
 */
export function VerifyEmailModal({
  title,
  action,
  onClose,
}: {
  title: ReactNode;
  action: string;
  onClose: () => void;
}) {
  return (
    <BusinessModal title={title} onClose={onClose}>
      <VerifyEmailNotice action={action} />
    </BusinessModal>
  );
}

/**
 * Para botões que agem direto (aceitar troca, reativar serviço): sem e-mail confirmado, `guard`
 * abre o aviso em vez de rodar a ação. Se a API recusar com 403 `email_not_verified` enquanto a
 * ação roda (a tela achava que estava confirmado), o aviso abre do mesmo jeito.
 */
export function useVerifiedEmailGate(): {
  guard: (action: string, run: () => Promise<void> | void) => void;
  dialog: ReactNode;
} {
  const verified = useEmailVerified();
  const [blocked, setBlocked] = useState<string | null>(null);
  const running = useRef<string | null>(null);

  // A recusa da API chega antes da Promise da ação terminar: quem estava rodando vira o aviso.
  useEffect(() => {
    if (!verified && running.current) setBlocked(running.current);
  }, [verified]);

  const guard = useCallback(
    (action: string, run: () => Promise<void> | void): void => {
      if (!verified) {
        setBlocked(action);
        return;
      }
      running.current = action;
      void Promise.resolve()
        .then(run)
        .catch(() => undefined)
        .finally(() => {
          if (running.current === action) running.current = null;
        });
    },
    [verified],
  );

  const dialog = blocked ? (
    <VerifyEmailModal
      title="Confirme seu e-mail"
      action={blocked}
      onClose={() => setBlocked(null)}
    />
  ) : null;
  return { guard, dialog };
}
