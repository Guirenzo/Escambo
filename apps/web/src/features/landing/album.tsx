import { ArrowLeftRight } from 'lucide-react';
import type { PointerEvent } from 'react';

/** As cores chapadas atrás da foto, como o fundo impresso de cada figurinha (.al-g-*). */
export type StickerGround = 'amber' | 'sky' | 'tomato' | 'lime' | 'lilac';

/**
 * A brilhante acompanha o ponteiro: o laminado desliza e a figurinha inclina, como quando se vira
 * uma figurinha holográfica na luz. Só escreve duas variáveis CSS; sem ponteiro, fica parada.
 */
export const HOLO = {
  onPointerMove(e: PointerEvent<HTMLElement>): void {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--hx', ((e.clientX - r.left) / r.width).toFixed(3));
    el.style.setProperty('--hy', ((e.clientY - r.top) / r.height).toFixed(3));
  },
  onPointerLeave(e: PointerEvent<HTMLElement>): void {
    e.currentTarget.style.removeProperty('--hx');
    e.currentTarget.style.removeProperty('--hy');
  },
};

/** O que se fala folheando o montinho do outro: tenho, tenho, falta. E aí, troca. */
const CHANT = ['Tenho', 'Tenho', 'Falta', 'Troco'] as const;

/** A faixa entre o pacotinho e a vitrine (decorativa: o leitor de tela não a ouve). */
export function Ribbon() {
  return (
    <div className="al-ribbon-wrap" aria-hidden="true">
      <div className="al-ribbon">
        <div className="al-ribbon-track">
          {['a', 'b', 'c', 'd', 'e', 'f'].map((run) => (
            <span className="al-ribbon-run" key={run}>
              {CHANT.map((word, i) => (
                <span key={i}>
                  <b className={word === 'Falta' ? 'al-ribbon-miss' : undefined}>{word}</b>
                  <ArrowLeftRight size={30} strokeWidth={3} />
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
