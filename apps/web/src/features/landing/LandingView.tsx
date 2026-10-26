import {
  ArrowLeftRight,
  BadgeCheck,
  Banknote,
  Coins,
  Scale,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Category } from '@escambo/types';
import { SkipLink } from '../../components/ui';
import { useCategories, usePublicSettings } from '../../lib/hooks';
import { scrollBehavior } from '../../lib/motion';
import { usePageTitle } from '../../lib/title';
import { categoryArt } from '../services/categoryArt';
import { DeviceShowcase } from './AppMock';
import { CategoryGrid } from './CategoryGrid';
import { factsFrom, percent, type LandingFacts } from './facts';
import { GuaranteeBento } from './GuaranteeBento';
import { HowItWorks } from './HowItWorks';
import { LandingFaq } from './LandingFaq';
import { PORTRAITS } from './photos';
import { PublicFooter } from './PublicFooter';
import { PublicHeader, type SectionLink } from './PublicHeader';
import { Showcase, type ShowcaseFilter } from './Showcase';
import { TradeSection } from './TradeSection';
import './landing.css';

/**
 * Topo: a promessa, a busca (filtra a vitrine logo abaixo, sem pedir login), atalhos das categorias
 * reais, as duas portas de entrada e as telas do app. Fundo escuro sólido; o brilho decorativo fica
 * numa camada à parte, escura o bastante para o texto manter o contraste no pior ponto.
 */
function Hero({
  barter,
  categories,
  filter,
  onSearch,
}: {
  barter: boolean;
  categories: Category[];
  filter: ShowcaseFilter;
  onSearch: (next: ShowcaseFilter) => void;
}) {
  const inputId = useId();
  const quickId = useId();
  const [text, setText] = useState(filter.q);
  // A busca limpa pela vitrine (o "x" do filtro) também limpa o campo.
  useEffect(() => setText(filter.q), [filter.q]);

  function submit(e: FormEvent): void {
    e.preventDefault();
    onSearch({ q: text.trim(), categoryId: filter.categoryId });
  }

  return (
    <section className="lp-hero" aria-labelledby="lp-hero-title">
      <div className="lp-hero-glow" aria-hidden="true" />
      <div className="lp-wrap lp-hero-grid">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow">
            <span className="lp-eyebrow-ico">
              {barter ? <ArrowLeftRight size={14} /> : <ShieldCheck size={14} />}
            </span>
            {barter
              ? 'Marketplace de freelancers com troca de serviços'
              : 'Marketplace de freelancers com pagamento protegido'}
          </p>
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
          {categories.length > 0 && (
            <div className="lp-quick" role="group" aria-labelledby={quickId}>
              <span className="lp-quick-label" id={quickId}>
                Atalhos
              </span>
              {categories.map((c) => {
                const { Icon } = categoryArt(c.slug);
                const on = filter.categoryId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="lp-quick-btn"
                    aria-pressed={on}
                    onClick={() => onSearch({ q: text.trim(), categoryId: on ? null : c.id })}
                  >
                    <Icon size={15} aria-hidden="true" />
                    {c.name}
                  </button>
                );
              })}
            </div>
          )}

          <div className="lp-hero-actions">
            <Link to="/cadastro" className="lp-btn lp-btn-amber lp-btn-lg">
              Criar conta
            </Link>
            <a
              href={barter ? '#troca' : '#como-funciona'}
              className="lp-btn lp-btn-light lp-btn-lg"
            >
              Ver como funciona
            </a>
          </div>
          <p className="lp-hero-login">
            Já tem conta? <Link to="/login">Entrar</Link>
          </p>
        </div>
        <div className="lp-hero-art">
          <DeviceShowcase barter={barter} />
        </div>
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

function Ways({ facts }: { facts: LandingFacts }) {
  const { fee, barter } = facts;
  return (
    <section className="lp-band lp-ways-band" id="jeitos" aria-labelledby="lp-ways-title">
      <div className="lp-wrap">
        <div className="lp-head">
          <p className="lp-kicker">Formas de pagamento</p>
          <h2 id="lp-ways-title">
            {barter ? 'Três jeitos de fechar negócio' : 'Dois jeitos de fechar negócio'}
          </h2>
          <p className="lp-sub">
            Você escolhe na proposta, e o valor de cada lado aparece antes de você confirmar.
          </p>
        </div>
        <ul className="lp-ways">
          <li className="lp-way">
            <span className="lp-ico">
              <Banknote size={22} aria-hidden="true" />
            </span>
            <h3>Dinheiro, com garantia</h3>
            <p>
              Você paga ao contratar e o valor fica guardado na plataforma. O freelancer recebe
              quando você aprova a entrega, ou por etapas em projetos maiores.
            </p>
            <p className="lp-cost">
              <span>Custo</span>
              {fee !== null
                ? `${percent(fee)} sobre o valor, descontados de quem recebe`
                : 'Uma taxa sobre o valor, descontada de quem recebe'}
            </p>
          </li>
          {barter && (
            <li className="lp-way lp-way-featured">
              <span className="lp-ico">
                <ArrowLeftRight size={22} aria-hidden="true" />
              </span>
              <h3>Troca de serviços</h3>
              <p>
                Você faz um trabalho para outra pessoa e ela faz um para você. Cada lado vira uma
                contratação, com prazo, chat e aprovação.
              </p>
              <p className="lp-cost">
                <span>Custo</span>
                {fee !== null
                  ? `Troca equilibrada não paga taxa. Com torna, ${percent(fee)} só sobre a torna`
                  : 'Troca equilibrada não paga taxa. Com torna, a taxa vale só sobre a torna'}
              </p>
            </li>
          )}
          <li className="lp-way">
            <span className="lp-ico">
              <Coins size={22} aria-hidden="true" />
            </span>
            <h3>Créditos Escambo</h3>
            <p>
              A moeda do banco de tempo. Você ganha créditos trabalhando e usa para contratar ou
              para destacar o seu serviço na busca.
            </p>
            <p className="lp-cost">
              <span>Custo</span>
              Sem taxa
            </p>
          </li>
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
          categories={roots}
          filter={filter}
          onSearch={(next) => {
            setFilter(next);
            setSearches((n) => n + 1);
          }}
        />
        <Showcase
          filter={filter}
          categories={roots}
          onClearQuery={() => setFilter((f) => ({ ...f, q: '' }))}
          onClearCategory={() => setFilter((f) => ({ ...f, categoryId: null }))}
        />
        {roots.length > 0 && <CategoryGrid categories={roots} barter={barter} />}
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
