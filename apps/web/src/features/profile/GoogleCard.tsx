import { Pill } from '../../components/ui';
import { GoogleMark } from '../auth/GoogleMark';
import { useAccountContact } from './contact';

/**
 * "Entrar com Google" no Perfil (RF-002): aparece só para a conta com conta Google vinculada, e
 * diz que ela entra também por ali. Desvincular não existe nesta versão.
 */
export function GoogleCard() {
  const contact = useAccountContact();
  if (!contact.data?.googleLinked) return null;
  return (
    <section className="card" aria-labelledby="google-card-title" data-testid="google-card">
      <div className="card-head">
        <h3 id="google-card-title" className="google-card-title">
          <GoogleMark /> Entrar com Google
        </h3>
        <Pill status="completed">Vinculado</Pill>
      </div>
      <p className="muted tiny">
        Sua conta do Escambo entra também pelo botão "Entrar com Google", com a conta Google
        vinculada a ela.{' '}
        {contact.data.hasPassword
          ? 'A senha continua valendo.'
          : 'Ela ainda não tem senha (veja o cartão Senha).'}
      </p>
    </section>
  );
}
