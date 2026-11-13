import {
  ArrowLeftRight,
  Check,
  Code,
  FileArchive,
  Lock,
  Palette,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { money, TRADE_EXAMPLE } from './facts';

/**
 * Telas do app desenhadas em HTML e CSS (não são imagens): a sala de uma contratação, a carteira e
 * uma proposta de troca, uma por aba do "Como funciona". São ilustração: tudo aqui dentro fica fora
 * da árvore de acessibilidade (`aria-hidden`) e a legenda de cada figura diz que nomes e valores
 * são exemplos.
 * O tamanho do texto acompanha a largura da moldura (unidades do contêiner), como numa imagem.
 */

const TORNA = TRADE_EXAMPLE.requested - TRADE_EXAMPLE.offered;

function Ico({ Icon, size = '1.15em' }: { Icon: LucideIcon; size?: string }) {
  return <Icon size={size} strokeWidth={2} aria-hidden="true" />;
}

// ---------- Os dois lados de uma troca (aba "Trocar") ----------

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
