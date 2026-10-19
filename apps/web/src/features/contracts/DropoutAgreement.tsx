import { BusinessButton, BusinessModal } from '../../components/BusinessActions';
import { useEffect, useState } from 'react';
import type { ContractWithHistory } from '@escambo/types';
import { Button } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { momentText } from '../../lib/deadline';
import { useAgreeDropout } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { canAgreeDropout } from '../profile/dropouts';

export function DropoutAgreement({
  contract: c,
  myId,
}: {
  contract: ContractWithHistory;
  myId: number;
}) {
  const { user } = useAuth();
  const agree = useAgreeDropout();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(Date.now);
  const end = c.dropout?.agreeUntil;
  useEffect(() => {
    if (!end || Date.parse(end) < Date.now()) return undefined;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Date.parse(end) - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [end, now]);
  const d = c.dropout;
  if (!d || c.status !== 'cancelled' || c.clientId !== myId) return null;
  const allowed = canAgreeDropout(d, Math.max(now, Date.now()));
  async function confirm(): Promise<void> {
    if (!d || !canAgreeDropout(d, Date.now())) return;
    try {
      await agree.mutateAsync(c.id);
      toast.success('Você confirmou que a desistência foi combinada.');
      setConfirming(false);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível confirmar');
    }
  }
  return (
    <section className="card" data-testid="dropout-agree">
      <h3>Desistência do freelancer</h3>
      {d.agreedAt ? (
        <p>Você confirmou que a desistência foi combinada.</p>
      ) : !d.counts ? (
        <p>Esta desistência já não conta no perfil do freelancer.</p>
      ) : allowed ? (
        <>
          <p>
            O freelancer desistiu em {momentText(d.at, user?.timezone)}. Se isso foi combinado com
            você, confirme até {momentText(d.agreeUntil, user?.timezone)}: a desistência deixa de
            contar no perfil dele.
          </p>
          <BusinessButton
            variant="secondary"
            disabled={agree.isPending}
            onClick={() => setConfirming(true)}
          >
            Foi combinado comigo
          </BusinessButton>
        </>
      ) : (
        <p>
          O prazo para confirmar que a desistência foi combinada terminou em{' '}
          {momentText(d.agreeUntil, user?.timezone)}.
        </p>
      )}
      {confirming && allowed && (
        <BusinessModal title="Confirmar desistência combinada" onClose={() => setConfirming(false)}>
          <p>Confirmar? Isso não muda o dinheiro, que já voltou para você.</p>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Voltar
            </Button>
            <BusinessButton disabled={agree.isPending} onClick={() => void confirm()}>
              {agree.isPending ? 'Confirmando…' : 'Confirmar'}
            </BusinessButton>
          </div>
        </BusinessModal>
      )}
    </section>
  );
}
