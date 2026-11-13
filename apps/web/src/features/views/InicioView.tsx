import {
  ArrowLeftRight,
  Bell,
  ChevronRight,
  Coins,
  Eye,
  EyeOff,
  LifeBuoy,
  Lock,
  Plus,
  Search,
  UserCog,
  UserRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { UserRole } from '@escambo/types';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import { brl } from '../../lib/format';
import { identityName, profileIdentity } from '../../lib/documents';
import { useNotifications, useProfilesMe, useWallet } from '../../lib/hooks';
import { MissionsCard } from '../dashboard/MissionsCard';
import { MyContracts } from '../dashboard/MyContracts';
import { MySticker } from '../dashboard/MySticker';
import { HowItWorks, ProgressCard } from '../dashboard/ProgressCard';
import { NearbyServices } from '../dashboard/NearbyServices';
import { CategoryStrip } from '../services/CategoryStrip';
import { unreadLabel } from '../shell/TopBar';

/** Cumprimento pela hora do aparelho: bom dia (5h–11h), boa tarde (12h–17h), boa noite. */
export function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** "Terça-feira, 20 de outubro": a data por extenso, na linha abaixo do cumprimento. */
export function todayLabel(date: Date): string {
  const text = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface Shortcut {
  to: string;
  label: string;
  /** A linha de baixo: o porquê do atalho, ou um número de agora (saldo, não lidas). */
  hint: string;
  Icon: LucideIcon;
}

/**
 * Atalhos da faixa de boas-vindas, por papel: o que mais se faz depois da ação principal (que é o
 * botão da faixa), com o número que interessa na linha de baixo quando há um.
 */
export function shortcutsFor(
  role: 'freelancer' | 'client',
  { balance, unread }: { balance: number | null; unread: number },
): Shortcut[] {
  const money = balance == null ? 'saldo e extrato' : `${brl(balance)} disponível`;
  const bell: Shortcut = {
    to: '/notificacoes',
    label: 'Notificações',
    hint: unread > 0 ? unreadLabel(unread) : 'tudo em dia',
    Icon: Bell,
  };
  const help: Shortcut = {
    to: '/suporte',
    label: 'Pedir ajuda',
    hint: 'fale com o suporte',
    Icon: LifeBuoy,
  };
  return role === 'freelancer'
    ? [
        {
          to: '/trocas',
          label: 'Propor uma troca',
          hint: 'serviço por serviço',
          Icon: ArrowLeftRight,
        },
        { to: '/carteira', label: 'Sacar meus ganhos', hint: money, Icon: Wallet },
        bell,
        help,
      ]
    : [
        { to: '/carteira', label: 'Adicionar saldo', hint: money, Icon: Wallet },
        bell,
        {
          to: '/perfil',
          label: 'Meu perfil',
          hint: 'foto, cidade e segurança',
          Icon: UserRound,
        },
        help,
      ];
}

/** O papel na faixa da figurinha de quem está logado. */
const ROLE_LABEL: Record<UserRole, string> = {
  client: 'Cliente',
  freelancer: 'Freelancer',
  company: 'Empresa',
  admin: 'Equipe Escambo',
};

/** A escolha de esconder os valores fica no aparelho (não é dado da conta). */
const HIDE_MONEY_KEY = 'escambo_hide_money';

function readHideMoney(): boolean {
  try {
    return localStorage.getItem(HIDE_MONEY_KEY) === '1';
  } catch {
    return false;
  }
}

/** Um valor da carteira na faixa: ícone e rótulo, o número grande e a dica de para que serve. */
function Money({
  Icon,
  label,
  value,
  hint,
  hidden,
}: {
  Icon: LucideIcon;
  label: string;
  value: ReactNode;
  hint: ReactNode;
  hidden: boolean;
}) {
  return (
    <div className="money">
      <span className="money-label">
        <Icon size={15} aria-hidden="true" />
        {label}
      </span>
      <strong className="money-value">
        {hidden ? (
          <>
            <span aria-hidden="true">•••••</span>
            <span className="sr-only">oculto</span>
          </>
        ) : (
          value
        )}
      </strong>
      <span className="money-hint">{hint}</span>
    </div>
  );
}

export function InicioView() {
  usePageTitle('Início');
  const { user } = useAuth();
  const wallet = useWallet();
  const profiles = useProfilesMe();
  const notifications = useNotifications();
  const [hideMoney, setHideMoney] = useState(readHideMoney);
  const w = wallet.data;
  const identity = profileIdentity(profiles.data);
  const name = identityName(profiles.data, user?.email);
  const avatarUrl = identity.avatarUrl;
  // Freelancer sem perfil não tem nome nos cards, nem Score, nem aparece em "Perto de mim".
  const needsProfile =
    user?.role === 'freelancer' && profiles.data != null && !profiles.data.freelancer;
  const isFreelancer = user?.role === 'freelancer';
  const now = new Date();
  // Com os valores escondidos, o atalho do dinheiro também não mostra o saldo.
  const shortcuts = shortcutsFor(isFreelancer ? 'freelancer' : 'client', {
    balance: w && !hideMoney ? w.balance : null,
    unread: notifications.data?.unreadCount ?? 0,
  });

  function toggleMoney(): void {
    const next = !hideMoney;
    setHideMoney(next);
    try {
      localStorage.setItem(HIDE_MONEY_KEY, next ? '1' : '0');
    } catch {
      // Sem armazenamento (janela anônima): a escolha vale só nesta visita.
    }
  }

  // O que é de quem está logado: as contratações com o progresso ao lado e, embaixo, as missões
  // em fileira (quem não tem missões não vê a fileira).
  const work = (
    <>
      <div className="home-grid">
        <div className="home-main">
          <MyContracts />
        </div>

        <div className="home-side">
          <ProgressCard />
          <HowItWorks freelancer={isFreelancer} />
        </div>
      </div>
      <div className="home-missions">
        <MissionsCard />
      </div>
    </>
  );
  // O catálogo: por onde começar a procurar e o que há de novo.
  const discover = (
    <>
      <section className="section" aria-labelledby="categories-title">
        <div className="section-head">
          <div>
            <h2 id="categories-title">Explore por categoria</h2>
            <p>Do reparo em casa ao app sob medida: escolha por onde começar.</p>
          </div>
        </div>
        <CategoryStrip variant="tiles" />
      </section>

      <NearbyServices />
    </>
  );

  return (
    <div className="page">
      {/* A capa do álbum de quem está logado: a figurinha da pessoa, o cumprimento com a ação
          principal, a carteira e os atalhos. Texto sempre sobre cor sólida. */}
      <section className="welcome" aria-labelledby="welcome-title">
        {/* Decorativa: o nome está no título e o nível, no cartão de progresso. */}
        <div className="welcome-art" aria-hidden="true">
          <MySticker
            name={name}
            avatarUrl={avatarUrl ?? null}
            roleLabel={ROLE_LABEL[user?.role ?? 'client']}
          />
        </div>
        <div className="welcome-body">
          <div className="welcome-main">
            <div className="welcome-text">
              <h1 id="welcome-title">{`${greetingFor(now)}, ${name}`}</h1>
              <p>
                {todayLabel(now)}.{' '}
                {isFreelancer
                  ? 'Seus serviços, contratos e ganhos num lugar só.'
                  : 'Encontre quem faz, acompanhe as contratações e pague com segurança.'}
              </p>
            </div>
            <div className="welcome-cta">
              {isFreelancer ? (
                <Link to="/servicos?novo=1" className="btn amber">
                  <Plus size={16} aria-hidden="true" /> Publicar um serviço
                </Link>
              ) : (
                <Link to="/servicos" className="btn amber">
                  <Search size={16} aria-hidden="true" /> Encontrar um profissional
                </Link>
              )}
            </div>
          </div>
          <div className="welcome-money" role="group" aria-label="Carteira">
            <Money
              Icon={Wallet}
              label="Saldo disponível"
              value={w ? brl(w.balance) : '—'}
              hint="para saque"
              hidden={hideMoney}
            />
            <Money
              Icon={Lock}
              label="Em escrow"
              value={w ? brl(w.balancePending) : '—'}
              hint="retido em contratações"
              hidden={hideMoney}
            />
            <Money
              Icon={Coins}
              label="Créditos Escambo"
              value={w ? String(w.credits) : '—'}
              hint={
                w && w.creditsPending > 0
                  ? `${w.creditsPending} em escrow`
                  : 'para contratar ou impulsionar'
              }
              hidden={hideMoney}
            />
            <button
              type="button"
              className="money-eye"
              aria-pressed={hideMoney}
              aria-label="Ocultar valores"
              title={hideMoney ? 'Mostrar valores' : 'Ocultar valores'}
              onClick={toggleMoney}
            >
              {hideMoney ? (
                <EyeOff size={18} aria-hidden="true" />
              ) : (
                <Eye size={18} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
        <ul className="quick-actions" aria-label="Atalhos">
          {shortcuts.map(({ to, label, hint, Icon }) => (
            <li key={to}>
              <Link to={to} className="quick-action">
                <span className="quick-ico" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="quick-text">
                  <strong>{label}</strong>
                  <span>{hint}</span>
                </span>
                <ChevronRight size={16} className="quick-go" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {needsProfile && (
        <p className="notice" data-testid="onboarding-notice">
          <UserCog size={14} /> Complete seu perfil de freelancer (nome, cidade e localização) para
          aparecer em "Perto de mim", ter Escambo Score e mostrar seu nome nos serviços.{' '}
          <Link to="/perfil">Completar perfil</Link>
        </p>
      )}

      {/* Quem presta serviço abre o app para tocar o trabalho: as contratações vêm antes do
          catálogo. Quem contrata começa procurando. */}
      {isFreelancer ? (
        <>
          {work}
          {discover}
        </>
      ) : (
        <>
          {discover}
          {work}
        </>
      )}
    </div>
  );
}
