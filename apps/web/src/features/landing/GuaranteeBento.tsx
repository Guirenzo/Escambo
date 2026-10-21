import {
  Check,
  Clock,
  Download,
  FileText,
  Gauge,
  Lock,
  MessagesSquare,
  ListChecks,
  Paperclip,
  Scale,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { days, money, TRADE_EXAMPLE } from './facts';

/**
 * "Combinado é garantido": no lugar de números de usuários e depoimentos, que o Escambo não tem,
 * as regras que protegem os dois lados. Cada bloco tem um recorte de tela desenhado em HTML, só
 * decorativo (`aria-hidden`): o texto do bloco já diz tudo.
 */

function Tile({
  id,
  Icon,
  title,
  wide = false,
  half = false,
  dark = false,
  art,
  children,
}: {
  id: string;
  Icon: LucideIcon;
  title: string;
  wide?: boolean;
  half?: boolean;
  /** O bloco da regra principal, no escuro. */
  dark?: boolean;
  art: ReactNode;
  children: ReactNode;
}) {
  const cls = [
    'lp-tile',
    wide ? 'lp-tile-wide' : '',
    half ? 'lp-tile-half' : '',
    dark ? 'lp-tile-dark' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li className={cls}>
      <div className="lp-tile-body">
        <span className="lp-ico">
          <Icon size={22} />
        </span>
        <h3 id={id}>{title}</h3>
        {children}
      </div>
      <div className="lp-tile-art" aria-hidden="true">
        {art}
      </div>
    </li>
  );
}

const TIMELINE = ['Proposta', 'Aceita', 'Entregue', 'Concluída'];

function EscrowArt() {
  return (
    <div className="lp-art-card">
      <div className="lp-art-row">
        <strong>Landing page</strong>
        <span className="lp-art-money">{money(TRADE_EXAMPLE.requested)}</span>
      </div>
      <p className="lp-art-muted">Entregue: falta a sua aprovação</p>
      <ol className="lp-tl">
        {TIMELINE.map((s, i) => (
          <li key={s} className={i < 2 ? 'done' : i === 2 ? 'now' : undefined}>
            <span className="lp-tl-dot" />
            {s}
          </li>
        ))}
      </ol>
      <p className="lp-art-chip lp-art-chip-amber">
        <Lock size={14} />
        Em garantia até você aprovar
      </p>
    </div>
  );
}

function MilestonesArt() {
  return (
    <ul className="lp-ms">
      <li className="paid">
        <Check size={14} />
        Etapa 1<span>Liberada</span>
      </li>
      <li className="held">
        <Lock size={14} />
        Etapa 2<span>Guardada</span>
      </li>
      <li>
        <Clock size={14} />
        Etapa 3<span>A seguir</span>
      </li>
    </ul>
  );
}

function ChatArt() {
  return (
    <div className="lp-chat">
      <p className="lp-bubble">Segue a primeira versão!</p>
      <p className="lp-bubble lp-bubble-file">
        <Paperclip size={14} />
        entrega-v1.pdf
      </p>
      <p className="lp-bubble lp-bubble-mine">Ficou ótimo, vou aprovar.</p>
    </div>
  );
}

function DisputeArt() {
  return (
    <div className="lp-art-card">
      <div className="lp-art-row">
        <strong>
          <Scale size={16} />
          Disputa
        </strong>
        <span className="lp-art-tag">Em análise</span>
      </div>
      <div className="lp-split">
        <span className="lp-split-a" />
        <span className="lp-split-b" />
      </div>
      <ul className="lp-split-legend">
        <li>
          <span className="lp-dot lp-dot-a" />
          Volta ao cliente
        </li>
        <li>
          <span className="lp-dot lp-dot-b" />
          Vai ao freelancer
        </li>
      </ul>
      <p className="lp-art-chip">
        <UserCheck size={14} />
        Decisão da equipe com base no histórico
      </p>
    </div>
  );
}

const SCORE_BARS: [string, number][] = [
  ['Nota', 92],
  ['Contratações', 70],
  ['Avaliações', 80],
  ['Resposta', 88],
];

function ScoreArt() {
  return (
    <div className="lp-art-card lp-score">
      <p className="lp-score-value">
        <strong>84</strong>
        <span>de 100</span>
      </p>
      <ul className="lp-bars">
        {SCORE_BARS.map(([label, value]) => (
          <li key={label}>
            <span>{label}</span>
            <span className="lp-bar">
              <span style={{ width: `${value}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DataArt() {
  return (
    <div className="lp-art-card">
      <p className="lp-file">
        <FileText size={16} />
        <span>meus-dados.json</span>
        <Download size={16} />
      </p>
      <p className="lp-art-chip">
        <ShieldCheck size={14} />
        Exclusão da conta pelo Perfil
      </p>
    </div>
  );
}

export function GuaranteeBento({ tacitDays }: { tacitDays: number | null }) {
  return (
    <section className="lp-band" id="garantia" aria-labelledby="lp-guarantee-title">
      <div className="lp-wrap">
        <div className="lp-head">
          <p className="lp-kicker">Garantia e confiança</p>
          <h2 id="lp-guarantee-title">Combinado é garantido</h2>
          <p className="lp-sub">
            As regras que protegem quem contrata e quem entrega, do pagamento à disputa.
          </p>
        </div>
        <ul className="lp-bento">
          <Tile
            id="lp-g-escrow"
            Icon={Lock}
            title="Pagamento em garantia"
            wide
            dark
            art={<EscrowArt />}
          >
            <p>
              O dinheiro sai da sua carteira, mas só chega ao freelancer quando você aprova.{' '}
              {tacitDays !== null
                ? `Se você não responder em ${days(tacitDays)}, a entrega é aprovada automaticamente.`
                : 'Sem resposta no prazo, a entrega é aprovada automaticamente.'}
            </p>
          </Tile>
          <Tile
            id="lp-g-milestones"
            Icon={ListChecks}
            title="Pagamento por marcos"
            art={<MilestonesArt />}
          >
            <p>
              Projetos grandes podem ser pagos por etapa. Cada marco é guardado e liberado
              separadamente.
            </p>
          </Tile>
          <Tile id="lp-g-chat" Icon={MessagesSquare} title="Chat por contratação" art={<ChatArt />}>
            <p>Conversa, arquivos e entregas no mesmo lugar, com o histórico guardado.</p>
          </Tile>
          <Tile id="lp-g-dispute" Icon={Scale} title="Disputa mediada" wide art={<DisputeArt />}>
            <p>
              Não deu certo? Abra uma disputa: a equipe analisa o histórico da contratação e decide
              a divisão do valor. Enquanto isso, o dinheiro fica congelado.
            </p>
          </Tile>
          <Tile id="lp-g-score" Icon={Gauge} title="Escambo Score" half art={<ScoreArt />}>
            <p>
              Uma nota de 0 a 100 que junta a nota das avaliações, o número de contratações e de
              avaliações e o tempo de resposta. As avaliações vêm só de contratações concluídas.
            </p>
          </Tile>
          <Tile id="lp-g-data" Icon={ShieldCheck} title="Seus dados" half art={<DataArt />}>
            <p>
              Baixe uma cópia dos seus dados ou peça a exclusão da conta pelo Perfil, quando quiser
              (LGPD). Os detalhes estão na <Link to="/privacidade">Política de Privacidade</Link>.
            </p>
          </Tile>
        </ul>
      </div>
    </section>
  );
}
