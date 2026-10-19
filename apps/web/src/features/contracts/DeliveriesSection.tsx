import { ExternalLink, PackageCheck } from 'lucide-react';
import type { ContractWithHistory } from '@escambo/types';
import { dtm } from '../../lib/format';

/** Só endereço http(s) vira link; o resto (javascript:, data:…) aparece como texto. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Entregas da contratação (RF-035): a mensagem e os links de cada entrega única, da mais recente à
 * primeira, para as duas partes, com o histórico das reentregas depois de cada revisão. Por marcos,
 * cada marco mostra a própria entrega (MilestonesSection).
 */
export function DeliveriesSection({
  contract,
  myId,
}: {
  contract: ContractWithHistory;
  myId: number;
}) {
  const deliveries = contract.deliveries ?? [];
  if (deliveries.length === 0) return null;
  const isFreelancer = contract.freelancerId === myId;
  const latestFirst = [...deliveries].reverse();

  return (
    <section className="card" aria-labelledby="deliveries-title" data-testid="deliveries">
      <div className="card-head">
        <h3 id="deliveries-title">
          <PackageCheck size={16} /> Entregas
        </h3>
        <span className="muted tiny">
          {deliveries.length === 1 ? '1 entrega' : `${deliveries.length} entregas`}
        </span>
      </div>
      <p className="muted tiny">
        {isFreelancer
          ? 'O que você mandou em cada entrega; o cliente vê o mesmo.'
          : 'O que o freelancer mandou em cada entrega. Arquivos também podem ter vindo pelo chat.'}
      </p>
      <ol className="timeline" aria-label="Entregas, da mais recente à primeira">
        {latestFirst.map((d, i) => {
          const n = deliveries.length - i;
          return (
            <li key={d.id} data-testid={`delivery-${n}`}>
              <span className="dot" />
              <div>
                <strong>
                  Entrega {n}
                  {n > 1 ? ' (reentrega)' : ''}
                </strong>
                {i === 0 && deliveries.length > 1 && (
                  <span className="muted tiny"> · mais recente</span>
                )}
                <div className="muted tiny">{dtm(d.deliveredAt)}</div>
                <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 0' }}>
                  {d.message}
                </p>
                {d.files.length > 0 && (
                  // Sem <li> aqui: a linha do tempo estiliza todo li descendente.
                  <div style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
                    <span className="muted tiny">Links da entrega:</span>
                    {d.files.map((url, k) => {
                      const href = safeHref(url);
                      return (
                        <div key={k}>
                          {href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {url} <ExternalLink size={12} aria-label="abre em nova aba" />
                            </a>
                          ) : (
                            <span>
                              {url}{' '}
                              <span className="muted tiny">(endereço sem http, não abre)</span>
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
