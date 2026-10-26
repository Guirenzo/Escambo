import { LifeBuoy } from 'lucide-react';
import { SupportDesk } from '../support/SupportDesk';

export function SupportSection() {
  return (
    <section id="suporte" className="stack adm-support">
      <div className="adm-h2">
        <span className="adm-ico green" aria-hidden="true">
          <LifeBuoy size={20} />
        </span>
        <div>
          <h2>Atendimento de suporte</h2>
          <p className="muted tiny">
            Respostas públicas chegam ao titular. Notas internas ficam apenas com a equipe e não
            contam como primeira resposta. O atendimento não movimenta saldo nem substitui a
            mediação financeira.
          </p>
        </div>
      </div>
      <SupportDesk admin />
    </section>
  );
}
