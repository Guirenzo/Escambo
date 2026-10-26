import {
  ArrowLeftRight,
  Bell,
  Check,
  ChevronLeft,
  CircleCheck,
  Code,
  FileArchive,
  Coins,
  Home,
  LayoutGrid,
  Lock,
  Megaphone,
  Menu,
  MessagesSquare,
  Palette,
  Search,
  Star,
  Trophy,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { BrandMark } from '../../components/BrandMark';
import { money, TRADE_EXAMPLE } from './facts';

/**
 * Telas do app desenhadas em HTML e CSS (não são imagens), no visual v2: lateral escura, cartões de
 * serviço com capa, indicadores. São ilustração: tudo aqui dentro fica fora da árvore de
 * acessibilidade (`aria-hidden`) e a legenda de cada figura diz que nomes e valores são exemplos.
 * O tamanho do texto acompanha a largura da moldura (unidades do contêiner), como numa imagem.
 */

const TORNA = TRADE_EXAMPLE.requested - TRADE_EXAMPLE.offered;

function Ico({ Icon, size = '1.15em' }: { Icon: LucideIcon; size?: string }) {
  return <Icon size={size} strokeWidth={2} aria-hidden="true" />;
}

/** Avatar de exemplo: só a inicial num círculo (nada de foto de gente "real"). */
function Initial({ letter, tone }: { letter: string; tone: string }) {
  return <span className={`am-av am-av-${tone}`}>{letter}</span>;
}

// ---------- Desktop: o Início do app ----------

const NAV: [string, LucideIcon, boolean?][] = [
  ['Início', Home, true],
  ['Serviços', LayoutGrid],
  ['Trocas', ArrowLeftRight],
];

function Sidebar() {
  return (
    <div className="am-side">
      <p className="am-logo">
        <BrandMark onDark className="am-logo-mark" />
        Escambo
      </p>
      <p className="am-group">Trabalho</p>
      {NAV.map(([label, Icon, on]) => (
        <p key={label} className={on ? 'am-item on' : 'am-item'}>
          <Ico Icon={Icon} />
          {label}
        </p>
      ))}
      <p className="am-group">Dinheiro</p>
      <p className="am-item">
        <Ico Icon={Wallet} />
        Carteira
      </p>
      <p className="am-group">Comunidade</p>
      <p className="am-item">
        <Ico Icon={Trophy} />
        Ranking
      </p>
      <p className="am-item">
        <Ico Icon={Bell} />
        Notificações<span className="am-badge">3</span>
      </p>
      <div className="am-user">
        <Initial letter="A" tone="rose" />
        <span>
          <strong>Ana</strong>
          Cliente
        </span>
      </div>
    </div>
  );
}

const KPIS: [string, string, string, LucideIcon, string][] = [
  ['Saldo disponível', money(1250), 'para saque', Wallet, 'green'],
  ['Em garantia', money(700), 'em contratações', Lock, 'amber'],
  ['Créditos Escambo', '120', 'para contratar', Coins, 'green'],
  ['Nível 3 · Profissional', '1.240 XP', '', Trophy, 'blue'],
];

const CARDS: {
  title: string;
  who: string;
  letter: string;
  avatar: string;
  tone: string;
  Icon: LucideIcon;
  price: number;
}[] = [
  {
    title: 'Landing page em React',
    who: 'Caio R.',
    letter: 'C',
    avatar: 'blue',
    tone: 'blue',
    Icon: Code,
    price: 1200,
  },
  {
    title: 'Identidade visual completa',
    who: 'Lia M.',
    letter: 'L',
    avatar: 'violet',
    tone: 'violet',
    Icon: Palette,
    price: 800,
  },
  {
    title: 'Posts para redes sociais',
    who: 'Rita S.',
    letter: 'R',
    avatar: 'rose',
    tone: 'rose',
    Icon: Megaphone,
    price: 480,
  },
];

/** Cartão de serviço do v2: capa no tom da categoria, avatar na borda, preço e "Aceita troca". */
export function MockServiceCard({ card }: { card: (typeof CARDS)[number] }) {
  return (
    <div className="am-card">
      <div className={`am-cover am-tone-${card.tone}`}>
        <span className="am-cover-art">
          <Ico Icon={card.Icon} size="1.6em" />
        </span>
      </div>
      <div className="am-card-body">
        <Initial letter={card.letter} tone={card.avatar} />
        <p className="am-card-title">{card.title}</p>
        <p className="am-card-who">
          {card.who}
          <span className="am-star">
            <Ico Icon={Star} size="1em" />
            5,0
          </span>
        </p>
        <div className="am-card-foot">
          <p className="am-price">
            <span>a partir de</span>
            {money(card.price)}
          </p>
          <span className="am-barter">
            <Ico Icon={ArrowLeftRight} size="1em" />
            Aceita troca
          </span>
        </div>
      </div>
    </div>
  );
}

function DesktopHome() {
  return (
    <div className="am am-desktop">
      <Sidebar />
      <div className="am-main">
        <div className="am-top">
          <p className="am-search">
            <Ico Icon={Search} />
            Buscar serviços ou tags…
          </p>
          <span className="am-bell">
            <Ico Icon={Bell} />
          </span>
          <Initial letter="A" tone="rose" />
        </div>
        <div className="am-hello">
          <Initial letter="A" tone="rose" />
          <p>
            <strong>Boa tarde, Ana</strong>
            Aqui está o resumo da sua atividade no Escambo.
          </p>
          <span className="am-btn">
            <Ico Icon={Search} />
            Encontrar um profissional
          </span>
        </div>
        <div className="am-kpis">
          {KPIS.map(([label, value, note, Icon, tone]) => (
            <div key={label} className="am-kpi">
              <p className="am-kpi-label">
                {label}
                <span className={`am-kpi-ico am-tone-${tone}`}>
                  <Ico Icon={Icon} />
                </span>
              </p>
              <p className="am-kpi-value">{value}</p>
              {note ? <p className="am-kpi-note">{note}</p> : <span className="am-progress" />}
            </div>
          ))}
        </div>
        <p className="am-sec">Descubra serviços</p>
        <div className="am-cards">
          {CARDS.map((card) => (
            <MockServiceCard key={card.title} card={card} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Celular: a proposta de troca ----------

/** Os dois lados da troca e a torna, como na tela de Trocas. */
function TradeSides() {
  return (
    <>
      <div className="am-side-box">
        <span className="am-side-ico am-tone-violet">
          <Ico Icon={Palette} />
        </span>
        <p>
          <span>Você oferece</span>
          <strong>Identidade visual</strong>
        </p>
        <b>{money(TRADE_EXAMPLE.offered)}</b>
      </div>
      <span className="am-seal">
        <Ico Icon={ArrowLeftRight} />
      </span>
      <div className="am-side-box">
        <span className="am-side-ico am-tone-blue">
          <Ico Icon={Code} />
        </span>
        <p>
          <span>Você recebe</span>
          <strong>Landing page</strong>
        </p>
        <b>{money(TRADE_EXAMPLE.requested)}</b>
      </div>
      <div className="am-torna">
        <Ico Icon={Wallet} />
        <p>
          <strong>Torna: você completa {money(TORNA)}</strong>
          Reservada na carteira até os dois aprovarem.
        </p>
      </div>
    </>
  );
}

function PhoneTrade() {
  return (
    <div className="am am-phone-app">
      <p className="am-status">
        <span>9:41</span>
        <span className="am-status-dots" />
      </p>
      <div className="am-phone-head">
        <Ico Icon={ChevronLeft} />
        <strong>Proposta de troca</strong>
        <span className="am-pill">Nova</span>
      </div>
      <div className="am-phone-body">
        <TradeSides />
        <p className="am-meta">
          <Ico Icon={CircleCheck} size="1em" />2 contratações · 2 revisões em cada
        </p>
        <span className="am-btn am-btn-full">Aceitar troca</span>
        <span className="am-btn am-btn-ghost am-btn-full">Fazer contraproposta</span>
      </div>
      <div className="am-tabbar">
        {(
          [
            ['Início', Home],
            ['Serviços', LayoutGrid],
            ['Trocas', ArrowLeftRight],
            ['Carteira', Wallet],
            ['Mais', Menu],
          ] as [string, LucideIcon][]
        ).map(([label, Icon]) => (
          <span key={label} className={label === 'Trocas' ? 'on' : undefined}>
            <Ico Icon={Icon} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Aviso flutuante (como as notificações do app): ícone, título e uma linha. */
function Toast({
  Icon,
  tone,
  title,
  children,
  className,
}: {
  Icon: LucideIcon;
  tone: string;
  title: string;
  children: ReactNode;
  className: string;
}) {
  return (
    <div className={`lp-toast ${className}`}>
      <span className={`lp-toast-ico lp-toast-${tone}`}>
        <Ico Icon={Icon} size="1.25em" />
      </span>
      <p>
        <strong>{title}</strong>
        {children}
      </p>
    </div>
  );
}

/**
 * A composição do topo: o notebook com o Início do app, o celular com uma proposta de troca e três
 * avisos que entram um depois do outro (só uma vez, e nada se move com movimento reduzido).
 */
export function DeviceShowcase({ barter }: { barter: boolean }) {
  const captionId = useId();
  return (
    <figure className="lp-devices" aria-labelledby={captionId}>
      <div className="lp-stage" aria-hidden="true">
        <div className="lp-laptop">
          <div className="lp-laptop-lid">
            <div className="lp-screen">
              <DesktopHome />
            </div>
          </div>
          <div className="lp-laptop-base" />
        </div>
        {barter && (
          <div className="lp-phone">
            <div className="lp-phone-screen">
              <PhoneTrade />
            </div>
          </div>
        )}
        <Toast Icon={Check} tone="green" title="Pagamento liberado" className="lp-toast-1">
          {money(TRADE_EXAMPLE.requested)} na sua carteira
        </Toast>
        {barter ? (
          <Toast
            Icon={ArrowLeftRight}
            tone="amber"
            title="Nova proposta de troca"
            className="lp-toast-2"
          >
            Identidade visual ⇄ Landing page
          </Toast>
        ) : (
          <Toast Icon={Lock} tone="amber" title="Valor em garantia" className="lp-toast-2">
            Liberado quando você aprovar
          </Toast>
        )}
        <Toast Icon={MessagesSquare} tone="blue" title="Nova mensagem" className="lp-toast-3">
          “Segue a entrega final!”
        </Toast>
      </div>
      <figcaption className="lp-devices-caption" id={captionId}>
        Telas do app Escambo. Nomes e valores são ilustrativos.
      </figcaption>
    </figure>
  );
}

// ---------- Telas das abas do "Como funciona" ----------

/** Moldura de navegador clara, para as telas das abas (na aba, o título da tela, como no app). */
function BrowserFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="am-browser">
      <p className="am-browser-bar">
        <span className="am-dots" />
        <span className="am-url">{title} · Escambo</span>
      </p>
      <div className="am-browser-body">{children}</div>
    </div>
  );
}

const TIMELINE = ['Proposta', 'Aceita', 'Entregue', 'Concluída'];

/** Contratar: a sala da contratação com a entrega esperando a aprovação. */
export function ContractScreen() {
  return (
    <BrowserFrame title="Sala da contratação">
      <div className="am am-panel">
        <p className="am-crumbs">Contratações › Landing page</p>
        <div className="am-row">
          <strong className="am-h">Landing page</strong>
          <span className="am-pill am-pill-blue">Entregue</span>
        </div>
        <div className="am-escrow">
          <Ico Icon={Lock} />
          <p>
            <strong>{money(TRADE_EXAMPLE.requested)} em garantia</strong>
            Liberado para o freelancer quando você aprovar.
          </p>
        </div>
        <ol className="am-timeline">
          {TIMELINE.map((step, i) => (
            <li key={step} className={i < 2 ? 'done' : i === 2 ? 'now' : undefined}>
              <span />
              {step}
            </li>
          ))}
        </ol>
        <div className="am-chat">
          <p className="am-bubble">Segue a entrega final, com o código no repositório.</p>
          <p className="am-bubble am-file">
            <Ico Icon={FileArchive} />
            landing-page-v2.zip
          </p>
          <p className="am-bubble am-mine">Ficou ótimo! Vou aprovar.</p>
        </div>
        <div className="am-actions">
          <span className="am-btn">Aprovar entrega</span>
          <span className="am-btn am-btn-ghost">Pedir revisão</span>
        </div>
      </div>
    </BrowserFrame>
  );
}

const STATEMENT: [string, string, boolean][] = [
  ['Pagamento liberado · Identidade visual', `+ ${money(680)}`, true],
  ['Pagamento liberado · Logo e cartão', `+ ${money(425)}`, true],
  ['Saque via PIX', `− ${money(500)}`, false],
];

/** Oferecer: a carteira de quem presta, com o extrato e o nível. */
export function WalletScreen() {
  return (
    <BrowserFrame title="Carteira">
      <div className="am am-panel">
        <strong className="am-h">Carteira</strong>
        <div className="am-kpis am-kpis-2">
          <div className="am-kpi">
            <p className="am-kpi-label">Saldo disponível</p>
            <p className="am-kpi-value">{money(2340)}</p>
            <span className="am-btn am-btn-sm">Sacar via PIX</span>
          </div>
          <div className="am-kpi">
            <p className="am-kpi-label">A receber</p>
            <p className="am-kpi-value">{money(1200)}</p>
            <p className="am-kpi-note">em garantia, até a aprovação</p>
          </div>
        </div>
        <ul className="am-statement">
          {STATEMENT.map(([what, value, inflow]) => (
            <li key={what}>
              <span className={inflow ? 'am-in' : 'am-out'}>
                <Ico Icon={inflow ? Check : Wallet} size="1em" />
              </span>
              {what}
              <b>{value}</b>
            </li>
          ))}
        </ul>
        <div className="am-level">
          <p>
            <strong>Nível 3 · Profissional</strong>
            <span>1.240 XP</span>
          </p>
          <span className="am-progress am-progress-62" />
        </div>
      </div>
    </BrowserFrame>
  );
}

/** Trocar: a proposta na tela de Trocas, com a torna calculada. */
export function TradeScreen() {
  return (
    <BrowserFrame title="Trocas">
      <div className="am am-panel">
        <div className="am-row">
          <strong className="am-h">Proposta de troca</strong>
          <span className="am-pill">Nova</span>
        </div>
        <div className="am-trade">
          <TradeSides />
        </div>
        <ol className="am-timeline">
          {['Proposta', 'Aceita', 'Entregas', 'Torna liberada'].map((step, i) => (
            <li key={step} className={i === 0 ? 'now' : undefined}>
              <span />
              {step}
            </li>
          ))}
        </ol>
        <div className="am-actions">
          <span className="am-btn">Aceitar troca</span>
          <span className="am-btn am-btn-ghost">Contraproposta</span>
        </div>
      </div>
    </BrowserFrame>
  );
}

/** Um recorte de tela para ilustrar um bloco: a moldura e a tela, decorativos. */
export function ScreenFigure({ children }: { children: ReactNode }) {
  return (
    <div className="lp-screen-fig" aria-hidden="true">
      {children}
    </div>
  );
}
