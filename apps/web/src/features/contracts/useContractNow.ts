import { useEffect, useState } from 'react';
import type { Contract } from '@escambo/types';

/** Atualiza ações e avisos nas horas gravadas, mesmo quando nenhuma mensagem chega pelo chat. */
export function useContractNow(
  c: Pick<Contract, 'status' | 'negotiation' | 'deadlineAt' | 'disputeOpensAt'>,
): number {
  const [now, setNow] = useState(Date.now);
  const response = c.negotiation?.respondBy;
  const deadline = c.negotiation?.current ? c.negotiation.current.deadlineAt : c.deadlineAt;
  const dispute = c.disputeOpensAt;
  useEffect(() => {
    const boundaries = c.status === 'pending' ? [response, deadline] : [dispute];
    const next = Math.min(
      ...boundaries
        .filter((at): at is string => Boolean(at))
        .map(Date.parse)
        .filter((at) => at > Date.now()),
    );
    if (!Number.isFinite(next)) return undefined;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(0, next - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [c.status, response, deadline, dispute, now]);
  // Uma oferta recém-carregada pode chegar depois do último tick deste componente.
  return Math.max(now, Date.now());
}
