import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BRAND_PIECE_A, BRAND_PIECE_B, BrandMark } from './BrandMark';

/** O símbolo da marca: decorativo (o nome vem ao lado em texto), nas cores do claro ou do escuro. */
describe('BrandMark', () => {
  it('fica fora da árvore de acessibilidade e desenha as duas peças', () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveClass('brand-mark');
    expect(svg).not.toHaveClass('on-dark');
    expect([...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual([
      BRAND_PIECE_A,
      BRAND_PIECE_B,
    ]);
    // Sem tamanho, quem manda é o CSS.
    expect(svg).not.toHaveAttribute('width');
  });

  it('sobre o escuro, com tamanho e classe extra', () => {
    const { container } = render(<BrandMark onDark size={34} className="bank-brand-mark" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveClass('brand-mark', 'on-dark', 'bank-brand-mark');
    expect(svg).toHaveAttribute('width', '34');
    expect(svg).toHaveAttribute('height', '34');
  });

  it('uma peça é a outra girada 180° na grade de 32 (nenhuma vale mais)', () => {
    const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const a = numbers(BRAND_PIECE_A);
    const b = numbers(BRAND_PIECE_B);
    // M x y · A rx ry rot large sweep x y · V y · H x
    const turn = (v: number) => Math.round((32 - v) * 1000) / 1000;
    expect([b[0], b[1]]).toEqual([turn(a[0]!), turn(a[1]!)]);
    expect([b[7], b[8]]).toEqual([turn(a[7]!), turn(a[8]!)]);
    expect(b[9]).toBe(turn(a[9]!));
    expect(b[10]).toBe(turn(a[10]!));
  });
});
