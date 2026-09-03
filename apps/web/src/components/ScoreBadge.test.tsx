import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScoreBadge } from './ScoreBadge';

const elite = {
  score: 92,
  tier: 'elite' as const,
  breakdown: { quality: 100, experience: 90, socialProof: 85, responsiveness: 80 },
};

describe('ScoreBadge (Escambo Score)', () => {
  it('mostra o valor e a faixa', () => {
    render(<ScoreBadge score={elite} />);
    expect(screen.getByText('92')).toBeInTheDocument();
    expect(screen.getByText('Elite')).toBeInTheDocument();
    expect(screen.queryByText('Qualidade')).not.toBeInTheDocument(); // sem breakdown por padrão
  });

  it('em modo detalhado mostra as 4 dimensões com seus valores', () => {
    render(<ScoreBadge score={elite} detailed />);
    for (const label of ['Qualidade', 'Experiência', 'Prova social', 'Responsividade']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('aplica a classe da faixa (cor)', () => {
    const { container } = render(<ScoreBadge score={{ ...elite, score: 30, tier: 'novato' }} />);
    expect(container.querySelector('.score-novato')).not.toBeNull();
    expect(screen.getByText('Novato')).toBeInTheDocument();
  });
});
