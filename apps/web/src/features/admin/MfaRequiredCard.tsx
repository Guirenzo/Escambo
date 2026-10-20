import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';

/** Código do 403 das rotas /admin quando o servidor exige 2FA e a conta ainda não ativou. */
export const MFA_REQUIRED = 'mfa_required';

export const isMfaRequired = (er: unknown): boolean =>
  (er as { code?: unknown } | null)?.code === MFA_REQUIRED;

/**
 * No lugar do painel, quando o servidor exige a verificação em duas etapas das contas admin
 * (ADMIN_MFA_REQUIRED) e esta ainda não ativou: um caminho só, em vez de um erro em cada fila.
 */
export function MfaRequiredCard() {
  return (
    <section className="card" aria-labelledby="admin-mfa-title" data-testid="admin-mfa-required">
      <div className="card-head">
        <h3 id="admin-mfa-title">
          <ShieldAlert size={16} /> Ative a verificação em duas etapas
        </h3>
      </div>
      <p>
        Este servidor exige a verificação em duas etapas das contas de administração. Ative-a no{' '}
        <Link to="/perfil#dois-fatores">cartão “Verificação em duas etapas” do seu perfil</Link>{' '}
        para usar o painel.
      </p>
    </section>
  );
}
