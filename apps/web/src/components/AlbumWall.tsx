import {
  BookOpen,
  Camera,
  Code,
  Droplets,
  GraduationCap,
  Hammer,
  Headset,
  Leaf,
  Megaphone,
  Music,
  PaintRoller,
  Palette,
  PenTool,
  Scissors,
  Smartphone,
  TrendingUp,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import './album-wall.css';

/** Quantos quadros a parede tem: sobra para a maior tela (o que passa da borda é cortado). */
export const WALL_CELLS = 120;

/** Um serviço por figurinha: os ofícios que o Escambo lista nas categorias. */
const ICONS: readonly LucideIcon[] = [
  Code,
  Smartphone,
  Headset,
  Palette,
  PenTool,
  Zap,
  Droplets,
  PaintRoller,
  Hammer,
  Wrench,
  GraduationCap,
  BookOpen,
  Megaphone,
  TrendingUp,
  Camera,
  Leaf,
  Scissors,
  Music,
];
const GROUNDS = ['amber', 'sky', 'tomato', 'lime', 'lilac'] as const;

/** Sorteio fixo por posição: a parede sai igual a cada visita (e nos testes). */
function roll(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A parede do álbum: quadros numerados e figurinhas de serviço sendo coladas (umas chegam depois,
 * como quem vai completando). É cenário (`aria-hidden`), atrás do formulário de entrar e do álbum
 * aberto da página inicial; quem a usa posiciona e escurece conforme o que vai por cima.
 */
export function AlbumWall() {
  return (
    <div className="aw-clip" aria-hidden="true">
      <div className="aw-wall" aria-hidden="true">
        {Array.from({ length: WALL_CELLS }, (_, i) => {
          const kind = roll(i, 1);
          const Icon = ICONS[Math.floor(roll(i, 5) * ICONS.length)]!;
          const late = roll(i, 2) < 0.1;
          const style = {
            '--t': `${((roll(i, 6) - 0.5) * 8).toFixed(1)}deg`,
            '--d': `${Math.round(late ? 2600 + roll(i, 3) * 7000 : roll(i, 3) * 1300)}ms`,
          } as CSSProperties;
          return (
            <span className="aw" key={i}>
              {String(((i * 7 + 3) % WALL_CELLS) + 1).padStart(2, '0')}
              {kind >= 0.27 && (
                <span
                  className={`aw-st al-g-${GROUNDS[Math.floor(roll(i, 4) * GROUNDS.length)]}${kind < 0.35 ? ' aw-foil' : ''}`}
                  style={style}
                >
                  <span className="aw-art">
                    <Icon strokeWidth={1.75} />
                  </span>
                  <span className="aw-band" />
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
