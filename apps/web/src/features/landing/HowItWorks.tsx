import {
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  Briefcase,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { onTablistKeyDown } from '../../components/ui';
import { ContractScreen, ScreenFigure, TradeScreen, WalletScreen } from './AppMock';
import { percent } from './facts';

type TabKey = 'contratar' | 'oferecer' | 'trocar';

interface Tab {
  key: TabKey;
  label: string;
  Icon: LucideIcon;
  title: string;
  steps: [string, string][];
  /** Para onde seguir lendo, dentro da página. */
  more: { href: string; label: string };
  screen: ReactNode;
}

function tabsFor(barter: boolean, fee: number | null): Tab[] {
  const tabs: Tab[] = [
    {
      key: 'contratar',
      label: 'Contratar',
      Icon: Search,
      title: 'Para quem contrata',
      steps: [
        ['Encontre quem faz', 'Busque por categoria, preço, prazo ou perto de você.'],
        [
          'Envie a proposta',
          'O valor sai da sua carteira, que você abastece via PIX, e fica guardado na plataforma.',
        ],
        [
          'Aprove e libere',
          'Converse e receba as entregas na sala da contratação. Aprovou, o pagamento é liberado.',
        ],
      ],
      more: { href: '#garantia', label: 'Ver as garantias' },
      screen: <ContractScreen />,
    },
    {
      key: 'oferecer',
      label: 'Oferecer',
      Icon: Briefcase,
      title: 'Para quem oferece serviços',
      steps: [
        ['Publique o que você faz', 'Serviços com preço, prazo e onde você atende.'],
        [
          'Aceite propostas',
          barter
            ? 'Em dinheiro, em créditos Escambo ou em troca de outro serviço.'
            : 'Em dinheiro ou em créditos Escambo.',
        ],
        [
          'Entregue e receba',
          'Saque por PIX ou transferência. Cada trabalho concluído rende XP, os pontos de experiência, e sobe o seu nível.',
        ],
      ],
      more: { href: '#jeitos', label: 'Ver os jeitos de receber' },
      screen: <WalletScreen />,
    },
  ];
  if (barter)
    tabs.push({
      key: 'trocar',
      label: 'Trocar',
      Icon: ArrowLeftRight,
      title: 'Para quem quer trocar',
      steps: [
        ['Proponha a troca', 'Escolha o serviço que você quer e ofereça um dos seus.'],
        [
          'O app calcula a torna',
          'Se os valores forem diferentes, quem recebe o serviço mais caro completa a diferença.',
        ],
        [
          'Cada um entrega a sua parte',
          fee !== null
            ? `Os dois aprovam e a torna é liberada, com ${percent(fee)} de taxa só sobre ela.`
            : 'Os dois aprovam e a torna é liberada, com a taxa da plataforma só sobre ela.',
        ],
      ],
      more: { href: '#troca', label: 'Simular a torna' },
      screen: <TradeScreen />,
    });
  return tabs;
}

/**
 * "Como funciona" em abas (padrão de abas do ARIA, ativação automática: setas, Home e End mudam a
 * aba). Cada aba tem os passos e uma tela do app. As duas chamadas de cadastro ficam fora das abas,
 * sempre à vista.
 */
export function HowItWorks({ barter, fee }: { barter: boolean; fee: number | null }) {
  const tabs = tabsFor(barter, fee);
  const [active, setActive] = useState<TabKey>('contratar');
  const base = useId();
  const current = tabs.find((t) => t.key === active) ?? tabs[0]!;
  return (
    <section className="lp-band lp-how" id="como-funciona" aria-labelledby="lp-how-title">
      <div className="lp-wrap">
        <div className="lp-head lp-head-center">
          <p className="lp-kicker">Como funciona</p>
          <h2 id="lp-how-title">Do primeiro contato ao pagamento</h2>
          <p className="lp-sub">
            Uma conta serve para os dois lados: você pode contratar e também oferecer serviços.
          </p>
        </div>
        <div
          className="lp-tabs"
          role="tablist"
          aria-label="Escolha o seu lado"
          onKeyDown={onTablistKeyDown}
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`${base}-tab-${t.key}`}
              aria-controls={`${base}-panel-${t.key}`}
              aria-selected={t.key === current.key}
              tabIndex={t.key === current.key ? 0 : -1}
              className="lp-tab"
              onClick={() => setActive(t.key)}
            >
              <t.Icon size={18} aria-hidden="true" />
              {t.label}
            </button>
          ))}
        </div>
        {tabs.map((t) => (
          <div
            key={t.key}
            role="tabpanel"
            id={`${base}-panel-${t.key}`}
            aria-labelledby={`${base}-tab-${t.key}`}
            hidden={t.key !== current.key}
            className="lp-panel"
          >
            <div className="lp-panel-copy">
              <h3>{t.title}</h3>
              <ol className="lp-steps">
                {t.steps.map(([title, text], i) => (
                  <li key={title}>
                    <span className="lp-step-n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div>
                      <h4>{title}</h4>
                      <p>{text}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <a href={t.more.href} className="lp-more">
                {t.more.label}
                <ArrowDown size={16} aria-hidden="true" />
              </a>
            </div>
            <ScreenFigure>{t.screen}</ScreenFigure>
          </div>
        ))}
        <div className="lp-how-cta">
          <p>Pronto para começar? É de graça criar a conta.</p>
          <div className="lp-how-cta-actions">
            <Link to="/cadastro?perfil=cliente" className="lp-btn lp-btn-primary">
              Criar conta de cliente
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <Link to="/cadastro?perfil=freelancer" className="lp-btn lp-btn-outline">
              Criar conta de freelancer
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
