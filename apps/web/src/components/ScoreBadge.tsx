import type { EscamboScore, ScoreBreakdown } from '@escambo/types';

const TIER_LABEL: Record<EscamboScore['tier'], string> = {
  novato: 'Novato',
  confiavel: 'Confiável',
  top: 'Top',
  elite: 'Elite',
};

const DIMS: { key: keyof ScoreBreakdown; label: string }[] = [
  { key: 'quality', label: 'Qualidade' },
  { key: 'experience', label: 'Experiência' },
  { key: 'socialProof', label: 'Prova social' },
  { key: 'responsiveness', label: 'Responsividade' },
];

/** Selo do Escambo Score (0-100 + faixa); `detailed` mostra o breakdown por dimensão. */
export function ScoreBadge({ score, detailed = false }: { score: EscamboScore; detailed?: boolean }) {
  return (
    <div className={`score score-${score.tier}`} title={`Escambo Score ${score.score}/100`}>
      <div className="score-head">
        <span className="score-shield" aria-hidden>
          🛡️
        </span>
        <strong className="score-value">{score.score}</strong>
        <span className="score-tier">{TIER_LABEL[score.tier]}</span>
      </div>
      {detailed && (
        <ul className="score-dims">
          {DIMS.map((d) => (
            <li key={d.key}>
              <span className="muted tiny">{d.label}</span>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${score.breakdown[d.key]}%` }} />
              </div>
              <b className="tiny">{score.breakdown[d.key]}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
