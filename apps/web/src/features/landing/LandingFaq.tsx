import { ArrowRight, ChevronDown, LifeBuoy } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { days, money, percent, type LandingFacts } from './facts';

/**
 * Dúvidas em `<details>` nativos: abrem e fecham pelo teclado e pelo leitor de tela sem script.
 * Os números (taxa, aprovação automática, saque mínimo) vêm da API; sem eles, a frase sai sem número.
 */
export function LandingFaq({ facts }: { facts: LandingFacts }) {
  const { fee, tacitDays, minWithdrawal, barter } = facts;
  const items: [string, ReactNode][] = [
    ...(barter
      ? ([
          [
            'O que é torna?',
            'É a diferença em dinheiro numa troca de serviços com valores diferentes. Quem recebe o serviço mais caro paga; o valor fica reservado na carteira e é liberado quando os dois lados aprovam.',
          ],
        ] as [string, ReactNode][])
      : []),
    [
      'Quanto custa usar o Escambo?',
      `Criar conta não custa nada. Em contratações em dinheiro, a plataforma fica com ${
        fee !== null
          ? `${percent(fee)} do valor, descontados de quem recebe`
          : 'uma parte do valor, descontada de quem recebe'
      }.${
        barter ? ' Na troca, a taxa incide só sobre a torna.' : ''
      } Em créditos Escambo, não há taxa.`,
    ],
    [
      'Quando o freelancer recebe?',
      `Quando o cliente aprova a entrega (ou cada marco, em projetos por etapas). ${
        tacitDays !== null
          ? `Sem resposta do cliente em ${days(tacitDays)}, a aprovação é automática.`
          : 'Sem resposta do cliente no prazo, a aprovação é automática.'
      }${minWithdrawal !== null ? ` O saque mínimo é de ${money(minWithdrawal)}.` : ''}`,
    ],
    [
      'E se o trabalho não vier como combinado?',
      'Você pode pedir revisão (duas estão incluídas em cada entrega) ou abrir uma disputa. A equipe analisa o histórico da contratação e decide.',
    ],
    [
      'O que são os créditos Escambo?',
      'A moeda interna do banco de tempo. Você ganha créditos trabalhando e usa para contratar ou para destacar os seus serviços na busca, sem taxa.',
    ],
    [
      'Posso contratar e também oferecer serviços?',
      'Pode. A mesma conta contrata e publica serviços: os perfis de cliente e de freelancer ficam lado a lado no seu Perfil. O que você escolhe no cadastro só define por onde começar.',
    ],
    [
      'Posso combinar o pagamento por fora?',
      'Não. Os Termos de Uso proíbem negociar fora da plataforma para fugir da taxa, e fora do Escambo não há garantia nem mediação.',
    ],
    [
      'Como meus dados são tratados?',
      <>
        A <Link to="/privacidade">Política de Privacidade</Link> diz quais dados guardamos e para
        quê. Pelo Perfil, você baixa uma cópia dos seus dados ou pede a exclusão da conta.
      </>,
    ],
  ];
  return (
    <section className="lp-band lp-faq-band" id="duvidas" aria-labelledby="lp-faq-title">
      <div className="lp-wrap lp-faq-grid">
        <div className="lp-head">
          <p className="lp-kicker">Dúvidas</p>
          <h2 id="lp-faq-title">Perguntas frequentes</h2>
          <p className="lp-sub">
            As regras completas estão nos <Link to="/termos">Termos de Uso</Link>.
          </p>
          <div className="lp-help">
            <span className="lp-help-ico" aria-hidden="true">
              <LifeBuoy size={22} />
            </span>
            <div>
              <p className="lp-help-title">Ainda com dúvida?</p>
              <p>
                Com a conta aberta, fale com a equipe pelo Suporte, dentro do app. Cada chamado
                guarda o histórico da conversa.
              </p>
              <Link to="/suporte" className="lp-more">
                Abrir o Suporte
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
        <div className="lp-faq">
          {items.map(([question, answer]) => (
            <details key={question} className="lp-qa">
              <summary>
                <span>{question}</span>
                <ChevronDown size={20} className="lp-qa-icon" aria-hidden="true" />
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
