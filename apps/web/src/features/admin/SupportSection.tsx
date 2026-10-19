import { LifeBuoy } from 'lucide-react';
import { SupportDesk } from '../support/SupportDesk';

export function SupportSection() {
  return (
    <section id="suporte" className="stack">
      <h2>
        <LifeBuoy size={19} /> Atendimento de suporte
      </h2>
      <p className="muted tiny">
        Respostas públicas chegam ao titular. Notas internas ficam apenas com a equipe e não contam
        como primeira resposta. O atendimento não movimenta saldo nem substitui a mediação
        financeira.
      </p>
      <SupportDesk admin />
    </section>
  );
}
