import {
  ArrowDown,
  ArrowLeftRight,
  BadgeCheck,
  Banknote,
  Coins,
  RefreshCw,
  Scale,
  Search,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlbumWall } from '../../components/AlbumWall';
import { SkipLink } from '../../components/ui';
import { useCategories, usePublicSettings } from '../../lib/hooks';
import { scrollBehavior } from '../../lib/motion';
import { usePageTitle } from '../../lib/title';
import { Ribbon } from './album';
import { factsFrom, percent, type LandingFacts } from './facts';
import { GuaranteeBento } from './GuaranteeBento';
import { HowItWorks } from './HowItWorks';
import { LandingFaq } from './LandingFaq';
import { Pack } from './Pack';
import { PORTRAITS } from './photos';
import { PublicFooter } from './PublicFooter';
import { PublicHeader, type SectionLink } from './PublicHeader';
import { Showcase, type ShowcaseFilter } from './Showcase';
import { TradeSection } from './TradeSection';
import './landing.css';
import './album.css';
import './album-pages.css';
import './pack.css';
import './album-motion.css';
import './hero.css';
import './trade.css';
import './sections.css';

/**
 * Topo: uma mensagem e uma ação. A promessa em letra grande e a busca (filtra a vitrine logo
 * abaixo, sem pedir login), sobre a parede do álbum. As categorias ficam na vitrine, como filtro.
 */
function Hero({
  barter,
  filter,
  onSearch,
}: {
  barter: boolean;
  filter: ShowcaseFilter;
  onSearch: (next: ShowcaseFilter) => void;
}) {
  const inputId = useId();
  const [text, setText] = useState(filter.q);
  // A busca limpa pela vitrine (o "x" do filtro) também limpa o campo.
  useEffect(() => setText(filter.q), [filter.q]);

  function submit(e: FormEvent): void {
    e.preventDefault();
    onSearch({ q: text.trim(), categoryId: filter.categoryId });
  }

  return (
    <section className="lp-hero" aria-labelledby="lp-hero-title">
      <AlbumWall />
      <div className="lp-wrap hx">
        {barter ? (
          <h1 id="lp-hero-title">
            <span className="lp-accent">Troque</span> o que você sabe fazer pelo que você precisa.
          </h1>
        ) : (
          <h1 id="lp-hero-title">
            Contrate freelancers com o pagamento <span className="lp-accent">protegido</span>.
          </h1>
        )}
        <p className="lp-lead">
          {barter
            ? 'Contrate com o pagamento guardado até você aprovar a entrega, ou pague com o seu trabalho: troque serviço por serviço, e o app calcula a diferença.'
            : 'O valor fica guardado na plataforma até você aprovar a entrega. Também dá para pagar com créditos Escambo, a moeda do banco de tempo, sem taxa.'}
        </p>

        <form className="lp-search" role="search" aria-label="Buscar serviços" onSubmit={submit}>
          <label htmlFor={inputId} className="lp-search-label">
            O que você precisa?
          </label>
          <div className="lp-search-row">
            <Search size={20} aria-hidden="true" className="lp-search-ico" />
            <input
              id={inputId}
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ex.: logo, faxina, aulas"
              autoComplete="off"
              enterKeyHint="search"
            />
            <button type="submit" className="lp-search-btn">
              Buscar
            </button>
          </div>
        </form>
        <a href={barter ? '#troca' : '#como-funciona'} className="hx-more">
          Ver como funciona
          <ArrowDown size={18} aria-hidden="true" />
        </a>
      </div>
      <div className="lp-wrap">
        <ul className="lp-assure">
          <li>
            <ShieldCheck size={20} aria-hidden="true" />
            Pagamento guardado até você aprovar
          </li>
          {barter ? (
            <li>
              <ArrowLeftRight size={20} aria-hidden="true" />
              Torna calculada pelo app
            </li>
          ) : (
            <li>
              <Coins size={20} aria-hidden="true" />
              Pagamento por etapas em projetos grandes
            </li>
          )}
          <li>
            <Scale size={20} aria-hidden="true" />
            Disputa com mediação da equipe
          </li>
          <li>
            <BadgeCheck size={20} aria-hidden="true" />
            Criar conta não custa nada
          </li>
        </ul>
      </div>
    </section>
  );
}

/**
 * Um jeito de fechar negócio, como figurinha que vira: a frente diz o nome e o custo; o verso
 * explica como funciona. O botão cobre a figurinha inteira (um alvo só, também no teclado), e a
 * face que está para trás sai da leitura.
 */
function Way({
  Icon,
  title,
  cost,
  tone,
  children,
}: {
  Icon: LucideIcon;
  title: string;
  cost: string;
  tone: 'amber' | 'green' | 'sky';
  children: string;
}) {
  const [flipped, setFlipped] = useState(false);
  const backId = useId();
  return (
    <li className={`wy wy-${tone}${flipped ? ' is-flipped' : ''}`}>
      <div className="wy-inner">
        <div className="wy-face wy-front" aria-hidden={flipped}>
          <span className="wy-ico">
            <Icon size={30} aria-hidden="true" />
          </span>
          <h3>{title}</h3>
          <p className="lp-cost">
            <span>Custo</span>
            {cost}
          </p>
        </div>
        <div className="wy-face wy-back" id={backId} aria-hidden={!flipped}>
          <p>{children}</p>
        </div>
      </div>
      <button
        type="button"
        className="wy-flip"
        aria-pressed={flipped}
        aria-controls={backId}
        aria-label={`Virar: ${title}`}
        onClick={() => setFlipped((f) => !f)}
      >
        {/* O nome não muda com o estado: quem diz se está virada é o aria-pressed. */}
        <span className="wy-flip-pill">
          <RefreshCw size={16} aria-hidden="true" />
          Virar
        </span>
      </button>
    </li>
  );
}

function Ways({ facts }: { facts: LandingFacts }) {
  const { fee, barter } = facts;
  return (
    <section className="lp-band lp-ways-band" id="jeitos" aria-labelledby="lp-ways-title">
      <div className="lp-wrap">
        <div className="lp-head">
          <h2 id="lp-ways-title">
            {barter ? 'Três jeitos de fechar negócio' : 'Dois jeitos de fechar negócio'}
          </h2>
          <p className="lp-sub">
            Você escolhe na proposta, e o valor de cada lado aparece antes de você confirmar. Vire a
            figurinha para ver como cada um funciona.
          </p>
        </div>
        <ul className="wy-list">
          <Way
            Icon={Banknote}
            title="Dinheiro, com garantia"
            tone="amber"
            cost={
              fee !== null
                ? `${percent(fee)} sobre o valor, descontados de quem recebe`
                : 'Uma taxa sobre o valor, descontada de quem recebe'
            }
          >
            Você paga ao contratar e o valor fica guardado na plataforma. O freelancer recebe quando
            você aprova a entrega, ou por etapas em projetos maiores.
          </Way>
          {barter && (
            <Way
              Icon={ArrowLeftRight}
              title="Troca de serviços"
              tone="green"
              cost={
                fee !== null
                  ? `Troca equilibrada não paga taxa. Com torna, ${percent(fee)} só sobre a torna`
                  : 'Troca equilibrada não paga taxa. Com torna, a taxa vale só sobre a torna'
              }
            >
              Você faz um trabalho para outra pessoa e ela faz um para você. Cada lado vira uma
              contratação, com prazo, chat e aprovação.
            </Way>
          )}
          <Way Icon={Coins} title="Créditos Escambo" tone="sky" cost="Sem taxa">
            A moeda do banco de tempo. Você ganha créditos trabalhando e usa para contratar ou para
            destacar o seu serviço na busca.
          </Way>
        </ul>
      </div>
    </section>
  );
}

/** As fotos da chamada final: decorativas, sem nome nem nota (são pessoas fictícias). */
const FINAL_PHOTOS = [PORTRAITS.designer, PORTRAITS.eletricista, PORTRAITS.professora];

function FinalCta({ barter }: { barter: boolean }) {
  return (
    <section className="lp-final" aria-labelledby="lp-final-title">
      <div className="lp-wrap">
        <div className="lp-final-card">
          <div className="lp-final-glow" aria-hidden="true" />
          <div className="lp-final-copy">
            <h2 id="lp-final-title">Comece com o que você já sabe fazer.</h2>
            <p>
              {barter
                ? 'Crie sua conta, publique um serviço ou proponha a primeira troca.'
                : 'Crie sua conta, publique um serviço ou faça a primeira contratação.'}
            </p>
            <div className="lp-actions">
              <Link to="/cadastro" className="lp-btn lp-btn-amber lp-btn-lg">
                Criar conta
              </Link>
              <Link to="/login" className="lp-btn lp-btn-light lp-btn-lg">
                Entrar
              </Link>
            </div>
          </div>
          <div className="lp-final-photos" aria-hidden="true">
            {FINAL_PHOTOS.map((p) => (
              <img
                key={p.src}
                src={p.src}
                width={400}
                height={500}
                alt=""
                loading="lazy"
                decoding="async"
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Página inicial pública (`/` sem sessão): a busca e a vitrine com serviços de verdade, as
 * categorias, como funciona para cada lado, os jeitos de pagar, a troca com a calculadora da torna
 * e as regras que protegem os dois lados. Taxa, prazos e saque mínimo vêm da API
 * (`/api/settings/public`); as categorias, de `/api/categories`; os serviços, de `/api/services`.
 */
export function LandingView() {
  usePageTitle('Contrate ou troque serviços');
  const settings = usePublicSettings();
  const categories = useCategories();
  const facts = factsFrom(settings.data);
  const { barter } = facts;
  const roots = categories.data ?? [];
  const [filter, setFilter] = useState<ShowcaseFilter>({ q: '', categoryId: null });
  /** Cada busca do topo leva o foco ao título da vitrine (onde o resultado aparece). */
  const [searches, setSearches] = useState(0);

  useEffect(() => {
    if (searches === 0) return;
    const title = document.getElementById('vitrine-title');
    title?.focus({ preventScroll: true });
    title?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  }, [searches]);

  // Na ordem em que as seções aparecem na página.
  const sections: SectionLink[] = [
    { href: '#como-funciona', label: 'Como funciona' },
    ...(barter ? [{ href: '#troca', label: 'Troca' }] : []),
    { href: '#garantia', label: 'Garantia' },
    { href: '#duvidas', label: 'Dúvidas' },
  ];

  // Saindo daqui (Criar conta, Entrar, uma categoria), a tela seguinte abre no topo, e não na
  // altura em que a pessoa estava na landing.
  useEffect(
    () => () => {
      document.documentElement.scrollTop = 0;
    },
    [],
  );

  return (
    <div className="lp">
      <SkipLink target="conteudo" />
      <PublicHeader sections={sections} />
      <main className="main lp-main" id="conteudo" tabIndex={-1}>
        <Hero
          barter={barter}
          filter={filter}
          onSearch={(next) => {
            setFilter(next);
            setSearches((n) => n + 1);
          }}
        />
        <Pack categories={roots} />
        <Ribbon />
        <Showcase
          filter={filter}
          categories={roots}
          onCategory={(id) => setFilter((f) => ({ ...f, categoryId: id }))}
          onClearQuery={() => setFilter((f) => ({ ...f, q: '' }))}
          onClearCategory={() => setFilter((f) => ({ ...f, categoryId: null }))}
        />
        <HowItWorks barter={barter} fee={facts.fee} />
        <Ways facts={facts} />
        {barter && <TradeSection fee={facts.fee} />}
        <GuaranteeBento tacitDays={facts.tacitDays} />
        <LandingFaq facts={facts} />
        <FinalCta barter={barter} />
      </main>
      <PublicFooter sections={sections} categories={roots} />
    </div>
  );
}
