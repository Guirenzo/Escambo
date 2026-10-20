/**
 * Movimento reduzido (WCAG 2.3.3): quem pede menos movimento no sistema também não ganha rolagem
 * animada disparada por código. O CSS já zera animações e transições (styles.css); o
 * `scrollIntoView({ behavior: 'smooth' })` não passa pelo CSS, então pergunta aqui.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** `behavior` de uma rolagem por código: suave, a menos que a pessoa peça menos movimento. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth');
