import { X } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { MAX_TAGS, normalizeTag, tagProblem } from './tags';

/**
 * Campo de tags do serviço (RF-024): cada tag vira um chip. Enter ou vírgula adiciona (colar
 * "a, b, c" adiciona as três), sair do campo também; o "×" do chip remove e devolve o foco ao
 * campo; Backspace com o campo vazio remove a última. A regra é a da RN-018 (tags.ts), e o leitor
 * de tela ouve o que entrou e o que saiu.
 */
export function TagsInput({
  value,
  onChange,
  label = 'Tags (opcional)',
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  label?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  /** Tenta adicionar cada pedaço; o que não entra fica no campo, com o motivo. */
  function add(pieces: string[]): void {
    let next = value;
    let problem: string | null = null;
    let rest = '';
    for (const piece of pieces) {
      const tag = normalizeTag(piece);
      if (!tag) continue;
      const why = tagProblem(tag, next);
      if (why) {
        problem ??= why;
        rest = rest ? `${rest}, ${piece.trim()}` : piece.trim();
        continue;
      }
      next = [...next, tag];
    }
    if (next !== value) {
      onChange(next);
      setAnnounce(`Tag adicionada: ${next.slice(value.length).join(', ')}`);
    }
    setText(rest);
    setError(problem);
  }

  function remove(tag: string): void {
    onChange(value.filter((t) => t !== tag));
    setAnnounce(`Tag removida: ${tag}`);
    setError(null);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if ((e.key === 'Enter' || e.key === ',') && text.trim()) {
      e.preventDefault(); // Enter com texto adiciona a tag, não envia o formulário
      add([text]);
    } else if (e.key === ',') {
      e.preventDefault();
    } else if (e.key === 'Backspace' && !text && value.length > 0) {
      remove(value[value.length - 1]!);
    }
  }

  return (
    <div className="tags-field">
      <label htmlFor={id}>{label}</label>
      {value.length > 0 && (
        <ul className="tag-chips" aria-label="Tags do serviço">
          {value.map((tag) => (
            <li key={tag} className="tag-chip">
              <span>{tag}</span>
              <button
                type="button"
                className="tag-chip-remove"
                aria-label={`Remover a tag ${tag}`}
                title="Remover"
                onClick={() => remove(tag)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        id={id}
        value={text}
        maxLength={200}
        placeholder={value.length >= MAX_TAGS ? 'Limite de tags atingido' : 'ex.: logo, figma'}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw.includes(',')) {
            // Vírgula digitada ou colada: o que vem antes dela vira tag; o resto fica no campo.
            const parts = raw.split(',');
            const tail = parts.pop() ?? '';
            add(parts);
            setText((kept) => (kept ? `${kept}, ${tail.trimStart()}` : tail.trimStart()));
          } else {
            setText(raw);
            if (error) setError(null);
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (text.trim()) add([text]);
        }}
      />
      <p id={`${id}-hint`} className="muted tiny">
        Enter ou vírgula adiciona · até {MAX_TAGS} tags de 2 a 30 caracteres ({value.length}/
        {MAX_TAGS})
      </p>
      {error && (
        <p id={`${id}-error`} className="error tiny" role="alert">
          {error}
        </p>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
