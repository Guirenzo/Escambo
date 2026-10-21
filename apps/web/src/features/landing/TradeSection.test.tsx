import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tornaQuote } from './facts';
import { ANNOUNCE_DELAY_MS, quoteSummary, TornaCalculator, TradeSection } from './TradeSection';

/**
 * A calculadora da torna: dois valores viram a torna, quem completa, a taxa vigente e o que chega
 * a quem recebe. O quadro muda na hora; o leitor de tela ouve o resumo quando a pessoa para de
 * digitar (região viva educada).
 */

const plain = (el: HTMLElement): string => (el.textContent ?? '').replace(/\s/g, ' ');
const announced = () => screen.getByTestId('torna-anuncio');
const result = () => screen.getByTestId('torna-resultado');

afterEach(() => {
  vi.useRealTimers();
});

describe('quoteSummary', () => {
  it('cada caso numa frase, com e sem a taxa', () => {
    const s = (t: string) => t.replace(/\s/g, ' ');
    expect(quoteSummary(null, 15)).toBe('Digite os dois valores para ver a torna.');
    expect(quoteSummary(tornaQuote(300, 300, 15), 15)).toBe(
      'Troca equilibrada: sem torna e sem taxa.',
    );
    expect(s(quoteSummary(tornaQuote(800, 1200, 15), 15))).toBe(
      'Torna de R$ 400: você completa. A taxa de 15% é R$ 60, e a outra pessoa recebe R$ 340.',
    );
    expect(s(quoteSummary(tornaQuote(1200, 800, 15), 15))).toBe(
      'Torna de R$ 400: a outra pessoa completa. A taxa de 15% é R$ 60, e você recebe R$ 340.',
    );
    expect(s(quoteSummary(tornaQuote(800, 1200, null), null))).toBe(
      'Torna de R$ 400: você completa. A taxa da plataforma sai de quem recebe a torna.',
    );
  });
});

describe('TornaCalculator', () => {
  it('abre com o exemplo (R$ 800 por R$ 1.200) e campos com rótulo e dica', () => {
    render(<TornaCalculator fee={15} />);
    const group = screen.getByRole('group', { name: 'Simule a torna' });
    const offered = within(group).getByLabelText('Você oferece');
    expect(offered).toHaveValue('800');
    expect(offered).toHaveAttribute('inputmode', 'decimal');
    expect(offered).toHaveAccessibleDescription('Valor do seu serviço');
    expect(within(group).getByLabelText('Você quer')).toHaveValue('1200');
    expect(plain(result())).toContain('Você completa R$ 400');
    expect(announced()).toHaveAttribute('role', 'status');
  });

  it('o quadro muda na hora e o anúncio só quando a pessoa para de digitar', () => {
    vi.useFakeTimers();
    render(<TornaCalculator fee={15} />);
    fireEvent.change(screen.getByLabelText('Você oferece'), { target: { value: '1.500' } });
    fireEvent.change(screen.getByLabelText('Você quer'), { target: { value: '900,50' } });
    expect(plain(result())).toContain('A outra pessoa completa R$ 599,50');
    expect(plain(result())).toContain('Taxa de 15%, só sobre a torna− R$ 89,93');
    expect(plain(result())).toContain('Você recebeR$ 509,57');
    expect(plain(announced())).toContain('Torna de R$ 400');
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    });
    expect(plain(announced())).toBe(
      'Torna de R$ 599,50: a outra pessoa completa. A taxa de 15% é R$ 89,93, e você recebe R$ 509,57.',
    );
  });

  it('valores iguais: sem torna e sem taxa', () => {
    render(<TornaCalculator fee={15} />);
    fireEvent.change(screen.getByLabelText('Você quer'), { target: { value: '800' } });
    expect(plain(result())).toContain('Sem torna');
    expect(plain(result())).toContain('Troca equilibrada: ninguém completa diferença');
  });

  it('valor que não é número: o campo fica inválido, com a explicação ligada a ele', () => {
    render(<TornaCalculator fee={15} />);
    const offered = screen.getByLabelText('Você oferece');
    fireEvent.change(offered, { target: { value: 'oitocentos' } });
    expect(offered).toHaveAttribute('aria-invalid', 'true');
    expect(offered).toHaveAccessibleDescription(
      'Valor do seu serviço Digite um valor em reais, como 1.200 ou 99,90.',
    );
    expect(plain(result())).toContain('Falta um valor');
    // Campo vazio não é erro: só falta o valor.
    fireEvent.change(offered, { target: { value: '' } });
    expect(offered).toHaveAttribute('aria-invalid', 'false');
    expect(plain(result())).toContain('Digite os dois valores para ver a torna.');
  });

  it('sem a taxa da API, a conta sai sem número de taxa', () => {
    render(<TornaCalculator fee={null} />);
    expect(plain(result())).not.toMatch(/\d+%/);
    expect(plain(result())).toContain('Quem recebe a torna fica comR$ 400 menos a taxa');
  });
});

describe('TradeSection', () => {
  it('título, a regra da taxa vinda da API e a foto decorativa', () => {
    render(<TradeSection fee={12.5} />);
    const region = screen.getByRole('region', { name: 'Como funciona uma troca' });
    expect(region).toHaveAttribute('id', 'troca');
    expect(plain(region)).toContain('Com torna, 12,5% só sobre ela.');
    const img = region.querySelector('img')!;
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(region.querySelector('.lp-trade-tag')).toHaveAttribute('aria-hidden', 'true');
  });
});
