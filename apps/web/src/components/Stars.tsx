import { Star } from 'lucide-react';
import { useId, useState } from 'react';

const LABELS = ['1 estrela', '2 estrelas', '3 estrelas', '4 estrelas', '5 estrelas'];

/** Nota em estrelas, somente leitura (ex.: "★★★★☆ 4.3 · 12"). */
export function Stars({
  value,
  count,
  size = 14,
  showValue = true,
}: {
  value: number;
  count?: number;
  size?: number;
  showValue?: boolean;
}) {
  const rounded = Math.round(value);
  const label =
    count != null ? `${value.toFixed(1)} de 5, ${count} avaliações` : `${value.toFixed(1)} de 5`;
  return (
    <span className="stars" role="img" aria-label={label} title={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={size}
          className={n <= rounded ? 'star on' : 'star'}
          aria-hidden="true"
        />
      ))}
      {showValue && (
        <span className="stars-value">
          {value > 0 ? value.toFixed(1) : '–'}
          {count != null && <span className="muted"> ({count})</span>}
        </span>
      )}
    </span>
  );
}

/**
 * Seletor de nota 1–5, acessível: é um grupo de rádios de verdade (teclado, leitor de tela),
 * desenhado como estrelas. Preview no hover; a seleção fica ao clicar/teclar.
 */
export function StarInput({
  value,
  onChange,
  name = 'rating',
  size = 26,
}: {
  value: number;
  onChange: (v: number) => void;
  name?: string;
  size?: number;
}) {
  const id = useId();
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div
      className="star-input"
      role="radiogroup"
      aria-label="Nota"
      onMouseLeave={() => setHover(0)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <label key={n} className={n <= shown ? 'on' : ''} onMouseEnter={() => setHover(n)}>
          <input
            type="radio"
            name={`${name}-${id}`}
            value={n}
            checked={value === n}
            onChange={() => onChange(n)}
            aria-label={LABELS[n - 1]}
          />
          <Star size={size} aria-hidden="true" />
        </label>
      ))}
      <span className="star-input-label" aria-live="polite">
        {shown ? LABELS[shown - 1] : 'Escolha a nota'}
      </span>
    </div>
  );
}
