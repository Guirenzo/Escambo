import { Award, ChevronRight, Flame, HandCoins, PackageCheck, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useGamification } from '../../lib/hooks';

/**
 * "Seu progresso" no Início: o nível num anel (a parte acesa é o quanto do nível já foi), o XP, o
 * que falta para o próximo, a posição no ranking, os dias seguidos de atividade e as conquistas.
 * O anel é um progressbar com nome; o número dentro dele é o nível, em texto sobre fundo sólido.
 */
export function ProgressCard() {
  const { data: g } = useGamification();
  const percent = Math.round(g?.progress.percent ?? 0);
  return (
    <section className="card progress-card" aria-labelledby="progress-title">
      <div className="card-head">
        <h3 id="progress-title">Seu progresso</h3>
        {g && (
          <span className="chip rank">
            <Flame size={12} aria-hidden="true" /> {g.streakDays} dias ativos
          </span>
        )}
      </div>
      {g ? (
        <>
          <div className="level-row-v3">
            <div
              className="level-ring"
              role="progressbar"
              aria-label="Progresso de nível"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              style={{ ['--p' as string]: `${percent}%` }}
            >
              <span className="level-ring-num" aria-hidden="true">
                {g.level}
              </span>
            </div>
            <div className="level-text">
              <span className="level-name">
                Nível {g.level} · {g.levelName}
              </span>
              <strong className="level-xp">{g.totalXp.toLocaleString('pt-BR')} XP</strong>
              <span className="muted tiny">
                {g.progress.xpToNextLevel != null
                  ? `faltam ${g.progress.xpToNextLevel} XP para o nível ${g.level + 1}`
                  : 'nível máximo'}
              </span>
            </div>
          </div>
          <Link to="/ranking" className="progress-rank">
            <span>
              {g.rank != null ? (
                <>
                  Você é <strong>#{g.rank}</strong> no ranking
                </>
              ) : (
                'Ainda fora do ranking'
              )}
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </Link>
          <div className="progress-badges">
            <h4>Conquistas</h4>
            <div className="badges">
              {g.badges.length === 0 ? (
                <span className="muted tiny">Conclua contratações para ganhar badges.</span>
              ) : (
                g.badges.map((b) => (
                  <span key={b.slug} className="badge" title={b.name}>
                    <Award size={12} aria-hidden="true" /> {b.name}
                  </span>
                ))
              )}
            </div>
          </div>
        </>
      ) : (
        <span className="muted tiny">Carregando…</span>
      )}
    </section>
  );
}

/**
 * Como o dinheiro anda numa contratação (escrow): três passos, do ponto de vista de quem lê.
 * Texto fixo, sem número: os valores de cada contratação estão nos cartões e na Sala.
 */
export function HowItWorks({ freelancer }: { freelancer: boolean }) {
  const steps = freelancer
    ? [
        { Icon: ShieldCheck, title: 'O cliente paga', text: 'o valor fica guardado em escrow' },
        { Icon: PackageCheck, title: 'Você entrega', text: 'arquivos e mensagens pela Sala' },
        { Icon: HandCoins, title: 'Aprovou, caiu', text: 'o líquido vai para a sua carteira' },
      ]
    : [
        { Icon: ShieldCheck, title: 'Você paga', text: 'o valor fica guardado em escrow' },
        { Icon: PackageCheck, title: 'O freelancer entrega', text: 'tudo registrado na Sala' },
        { Icon: HandCoins, title: 'Você aprova', text: 'só então o valor é liberado' },
      ];
  return (
    <section className="card how-card" aria-labelledby="how-title">
      <h3 id="how-title">Pagamento protegido</h3>
      <ol className="how-steps">
        {steps.map(({ Icon, title, text }) => (
          <li key={title}>
            <span className="how-ico" aria-hidden="true">
              <Icon size={18} />
            </span>
            <span>
              <strong>{title}</strong>
              <span className="muted tiny">{text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
