import {
  ArrowLeftRight,
  Bell,
  ChevronRight,
  Coins,
  LifeBuoy,
  Lock,
  Plus,
  Search,
  ShieldCheck,
  UserCog,
  UserRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { Stat } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';
import { brl, displayName } from '../../lib/format';
import { useNotifications, useProfilesMe, useWallet } from '../../lib/hooks';
import { MissionsCard } from '../dashboard/MissionsCard';
import { MyContracts } from '../dashboard/MyContracts';
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

/** "Terça-feira, 20 de outubro": a data por extenso acima do cumprimento. */
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
  tone: 'green' | 'amber' | 'blue' | 'violet';
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
    tone: 'blue',
  };
  const help: Shortcut = {
    to: '/suporte',
    label: 'Pedir ajuda',
    hint: 'fale com o suporte',
    Icon: LifeBuoy,
    tone: 'violet',
  };
  return role === 'freelancer'
    ? [
        {
          to: '/trocas',
          label: 'Propor uma troca',
          hint: 'serviço por serviço',
          Icon: ArrowLeftRight,
          tone: 'amber',
        },
        { to: '/carteira', label: 'Sacar meus ganhos', hint: money, Icon: Wallet, tone: 'green' },
        bell,
        help,
      ]
    : [
        { to: '/carteira', label: 'Adicionar saldo', hint: money, Icon: Wallet, tone: 'green' },
        bell,
        {
          to: '/perfil',
          label: 'Meu perfil',
          hint: 'foto, cidade e segurança',
          Icon: UserRound,
          tone: 'amber',
        },
        help,
      ];
}

export function InicioView() {
  usePageTitle('Início');
  const { user } = useAuth();
  const wallet = useWallet();
  const profiles = useProfilesMe();
  const notifications = useNotifications();
  const w = wallet.data;
  const name = displayName(
    profiles.data?.freelancer?.fullName ?? profiles.data?.client?.fullName,
    user?.email,
  );
  const avatarUrl =
    profiles.data?.freelancer?.avatarUrl ?? profiles.data?.client?.avatarUrl ?? null;
  // Freelancer sem perfil não tem nome nos cards, nem Score, nem aparece em "Perto de mim".
  const needsProfile =
    user?.role === 'freelancer' && profiles.data != null && !profiles.data.freelancer;
  const isFreelancer = user?.role === 'freelancer';
  const now = new Date();
  const shortcuts = shortcutsFor(isFreelancer ? 'freelancer' : 'client', {
    balance: w ? w.balance : null,
    unread: notifications.data?.unreadCount ?? 0,
  });

  return (
    <div className="page">
      {/* Faixa de boas-vindas: texto sempre sobre o verde sólido; a foto é ilustração (pessoas
          fictícias), fica numa coluna própria e some no celular. */}
      <section className="welcome" aria-labelledby="welcome-title">
        <div className="welcome-main">
          <div className="welcome-who">
            <Avatar url={avatarUrl} name={name} size="lg" />
            <div className="welcome-text">
              <span className="welcome-eyebrow">{todayLabel(now)}</span>
              <h1 id="welcome-title">{`${greetingFor(now)}, ${name}`}</h1>
              <p>
                {isFreelancer
                  ? 'Seus serviços, contratos e ganhos num lugar só.'
                  : 'Encontre quem faz, acompanhe as contratações e pague com segurança.'}
              </p>
            </div>
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
          <ul className="quick-actions" aria-label="Atalhos">
            {shortcuts.map(({ to, label, hint, Icon, tone }) => (
              <li key={to}>
                <Link to={to} className="quick-action">
                  <span className={`quick-ico tone-${tone}`} aria-hidden="true">
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
        </div>
        <div className="welcome-art" aria-hidden="true">
          <img
            src="/img/pessoas/dupla-troca-400.webp"
            srcSet="/img/pessoas/dupla-troca-400.webp 400w, /img/pessoas/dupla-troca.webp 800w"
            sizes="22rem"
            alt=""
            width={800}
            height={533}
          />
          <span className="welcome-badge">
            <span className="welcome-badge-ico">
              <ShieldCheck size={18} />
            </span>
            <span>
              <strong>Pagamento protegido</strong>
              <span>o valor fica em escrow até a aprovação</span>
            </span>
          </span>
        </div>
      </section>

      {needsProfile && (
        <p className="notice" data-testid="onboarding-notice">
          <UserCog size={14} /> Complete seu perfil de freelancer (nome, cidade e localização) para
          aparecer em "Perto de mim", ter Escambo Score e mostrar seu nome nos serviços.{' '}
          <Link to="/perfil">Completar perfil</Link>
        </p>
      )}

      <div className="kpis">
        <Stat
          Icon={Wallet}
          label="Saldo disponível"
          value={w ? brl(w.balance) : '—'}
          hint="para saque"
        />
        <Stat
          Icon={Lock}
          label="Em escrow"
          value={w ? brl(w.balancePending) : '—'}
          hint="retido em contratações"
          tone="amber"
        />
        <Stat
          Icon={Coins}
          label="Créditos Escambo"
          value={w ? String(w.credits) : '—'}
          hint={
            w && w.creditsPending > 0
              ? `${w.creditsPending} em escrow`
              : 'para contratar ou impulsionar'
          }
        />
      </div>

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

      <div className="home-grid">
        <div className="home-main">
          <MyContracts />
        </div>

        <div className="home-side">
          <ProgressCard />
          <MissionsCard />
          <HowItWorks freelancer={isFreelancer} />
        </div>
      </div>
    </div>
  );
}
