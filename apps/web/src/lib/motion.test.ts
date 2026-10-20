import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, scrollBehavior } from './motion';

const original = window.matchMedia;

function mockMatchMedia(reduce: boolean): void {
  window.matchMedia = vi.fn((query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = original;
});

describe('movimento reduzido', () => {
  it('sem matchMedia (navegador antigo, jsdom) rola suave', () => {
    // @ts-expect-error simula a ausência da API
    window.matchMedia = undefined;
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe('smooth');
  });

  it('com a preferência do sistema, a rolagem por código é instantânea', () => {
    mockMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe('auto');
  });

  it('sem a preferência, continua suave', () => {
    mockMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe('smooth');
  });
});
