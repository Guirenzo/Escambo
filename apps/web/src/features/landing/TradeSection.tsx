import { ArrowLeftRight, Lock, Percent, Scale } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { money, parseMoney, percent, TRADE_EXAMPLE, tornaQuote, type TornaQuote } from './facts';
import { PORTRAITS, type Photo } from './photos';

/** Quanto esperar, depois da última tecla, para anunciar o resultado ao leitor de tela. */
export const ANNOUNCE_DELAY_MS = 600;

/** A frase que o leitor de tela ouve (e que resume o quadro do resultado). */
export function quoteSummary(quote: TornaQuote | null, fee: number | null): string {
  if (!quote) return 'Digite os dois valores para ver a torna.';
  if (quote.payer === 'none') return 'Troca equilibrada: sem torna e sem taxa.';
  const who = quote.payer === 'you' ? 'você completa' : 'a outra pessoa completa';
  const receiver = quote.payer === 'you' ? 'a outra pessoa recebe' : 'você recebe';
  const rest =
    fee !== null && quote.feeValue !== null && quote.net !== null
      ? `A taxa de ${percent(fee)} é ${money(quote.feeValue)}, e ${receiver} ${money(quote.net)}.`
      : `A taxa da plataforma sai de quem recebe a torna.`;
  return `Torna de ${money(quote.torna)}: ${who}. ${rest}`;
}

function MoneyField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const hintId = useId();
  const errorId = useId();
  const invalid = value.trim() !== '' && parseMoney(value) === null;
  return (
    <div className="lp-calc-field">
      <label htmlFor={id}>{label}</label>
      <span className="lp-calc-hint" id={hintId}>
        {hint}
      </span>
      <span className="lp-calc-input">
        <span aria-hidden="true">R$</span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
        />
      </span>
      {invalid && (
        <span className="lp-calc-error" id={errorId}>
          Digite um valor em reais, como 1.200 ou 99,90.
        </span>
      )}
    </div>
  );
}

/** Quanto a balança pende, em graus: positivo desce o lado do serviço que você quer. */
export function balanceTip(offered: number | null, requested: number | null): number {
  if (offered === null || requested === null) return 0;
  const top = Math.max(offered, requested);
  if (top <= 0) return 0;
  return Math.max(-12, Math.min(12, ((requested - offered) / top) * 16));
}

/**
 * Um lado da troca como figurinha: a foto e o nome do serviço são ilustração (pessoa e serviço
 * fictícios, fora da leitura); o preço é o campo, editável como a etiqueta da figurinha. A torna,
 * quando há, aparece em cima do lado mais leve (é ela que equilibra a balança).
 */
function TradeCard({
  title,
  photo,
  ground,
  torna,
  children,
}: {
  title: string;
  photo: Photo;
  ground: 'lilac' | 'sky';
  torna: string | null;
  children: ReactNode;
}) {
  return (
    <div className={`tx-card al-g-${ground}`}>
      {torna && (
        <span className="tx-torna" aria-hidden="true">
          + {torna} de torna
        </span>
      )}
      <span className="tx-photo" aria-hidden="true">
        <img
          src={photo.src}
          srcSet={photo.srcSet}
          sizes="15rem"
          width={photo.width}
          height={photo.height}
          alt=""
          loading="lazy"
          decoding="async"
        />
      </span>
      <span className="tx-band" aria-hidden="true">
        {title}
      </span>
      {children}
    </div>
  );
}

/**
 * Calculadora da torna: dois valores viram a torna, quem paga, a taxa (a vigente, de
 * /api/settings/public) e o que chega a quem recebe. O recibo muda a cada tecla; o leitor de tela
 * ouve o resumo numa região viva educada, quando a pessoa para de digitar.
 */
export function TornaCalculator({ fee }: { fee: number | null }) {
  const titleId = useId();
  const [offered, setOffered] = useState(String(TRADE_EXAMPLE.offered));
  const [requested, setRequested] = useState(String(TRADE_EXAMPLE.requested));
  const a = parseMoney(offered);
  const b = parseMoney(requested);
  const quote = a !== null && b !== null ? tornaQuote(a, b, fee) : null;
  const summary = quoteSummary(quote, fee);
  const [announced, setAnnounced] = useState(summary);
  useEffect(() => {
    const t = window.setTimeout(() => setAnnounced(summary), ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [summary]);

  return (
    <div className="lp-calc" role="group" aria-labelledby={titleId}>
      <div className="tx-head">
        <h3 id={titleId}>Simule a torna</h3>
        <p>Ponha o valor de cada serviço. O resultado segue as regras do app.</p>
      </div>
      {/* A balança: as duas figurinhas são os pratos; a mais cara desce e a outra sobe. */}
      <div className="tx-balance" style={{ ['--tip' as string]: balanceTip(a, b) }}>
        <div className="tx-pair">
          <TradeCard
            title="Identidade visual"
            photo={PORTRAITS.designer}
            ground="lilac"
            torna={quote?.payer === 'you' ? money(quote.torna) : null}
          >
            <MoneyField
              label="Você oferece"
              hint="Valor do seu serviço"
              value={offered}
              onChange={setOffered}
            />
          </TradeCard>
          <span className="tx-coin" aria-hidden="true">
            <ArrowLeftRight size={24} strokeWidth={2.5} />
          </span>
          <TradeCard
            title="Landing page em React"
            photo={PORTRAITS.dev}
            ground="sky"
            torna={quote?.payer === 'other' ? money(quote.torna) : null}
          >
            <MoneyField
              label="Você quer"
              hint="Valor do serviço da outra pessoa"
              value={requested}
              onChange={setRequested}
            />
          </TradeCard>
        </div>
        <div className="tx-scale" aria-hidden="true">
          <span className="tx-beam">
            <i className="tx-stem tx-stem-l" />
            <i className="tx-stem tx-stem-r" />
          </span>
          <span className="tx-fulcrum" />
        </div>
      </div>
      <div className="tx-ticket" data-testid="torna-resultado">
        <p className="lp-calc-headline">
          {!quote ? (
            'Falta um valor'
          ) : quote.payer === 'none' ? (
            'Sem torna'
          ) : (
            <>
              {quote.payer === 'you' ? 'Você completa' : 'A outra pessoa completa'}{' '}
              <strong>{money(quote.torna)}</strong>
            </>
          )}
        </p>
        {!quote ? (
          <p className="lp-calc-note">Digite os dois valores para ver a torna.</p>
        ) : quote.payer === 'none' ? (
          <p className="lp-calc-note">
            Troca equilibrada: ninguém completa diferença, e não há taxa.
          </p>
        ) : (
          <dl className="lp-calc-rows">
            <div>
              <dt>Torna (a diferença)</dt>
              <dd>{money(quote.torna)}</dd>
            </div>
            {fee !== null && quote.feeValue !== null && quote.net !== null ? (
              <>
                <div>
                  <dt>Taxa de {percent(fee)}, só sobre a torna</dt>
                  <dd>− {money(quote.feeValue)}</dd>
                </div>
                <div className="lp-calc-net">
                  <dt>{quote.payer === 'you' ? 'A outra pessoa recebe' : 'Você recebe'}</dt>
                  <dd>{money(quote.net)}</dd>
                </div>
              </>
            ) : (
              <div className="lp-calc-net">
                <dt>Quem recebe a torna fica com</dt>
                <dd>{money(quote.torna)} menos a taxa</dd>
              </div>
            )}
          </dl>
        )}
        <p className="lp-calc-foot">
          <Lock size={14} aria-hidden="true" />A torna fica reservada na carteira até os dois
          aprovarem.
        </p>
      </div>
      <p className="tx-note">As pessoas e os serviços das figurinhas são ilustrativos.</p>
      <p className="sr-only" role="status" data-testid="torna-anuncio">
        {announced}
      </p>
    </div>
  );
}

/**
 * "Como funciona uma troca": o que acontece numa troca, à esquerda, e a calculadora da torna, à
 * direita. Só aparece com a troca ligada no painel.
 */
export function TradeSection({ fee }: { fee: number | null }) {
  return (
    <section className="lp-band lp-trade" id="troca" aria-labelledby="lp-trade-title">
      <div className="lp-wrap tx">
        <div className="lp-trade-copy">
          <h2 id="lp-trade-title">Como funciona uma troca</h2>
          <p className="lp-trade-lead">
            Você faz um trabalho para outra pessoa e ela faz um para você: cada lado vira uma
            contratação, com prazo, chat e aprovação. Se os valores forem diferentes, quem recebe o
            serviço mais caro completa a diferença em dinheiro. Essa diferença é a{' '}
            <strong>torna</strong>.
          </p>
          <ul className="lp-trade-points">
            <li>
              <Lock size={18} aria-hidden="true" />
              <span>
                A torna fica reservada na carteira e só é liberada quando os dois aprovam.
              </span>
            </li>
            <li>
              <Percent size={18} aria-hidden="true" />
              <span>
                {fee !== null
                  ? `Troca equilibrada não paga taxa. Com torna, ${percent(fee)} só sobre ela.`
                  : 'Troca equilibrada não paga taxa. Com torna, a taxa vale só sobre ela.'}
              </span>
            </li>
            <li>
              <Scale size={18} aria-hidden="true" />
              <span>Deu errado? Abra uma disputa: a equipe analisa o histórico e decide.</span>
            </li>
          </ul>
        </div>
        <TornaCalculator fee={fee} />
      </div>
    </section>
  );
}
