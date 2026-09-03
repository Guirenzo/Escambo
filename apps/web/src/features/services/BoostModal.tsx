import { useState } from 'react';
import type { Service } from '@escambo/types';
import { Button, Modal, QueryState } from '../../components/ui';
import { useBoostPlans, useCreateBoost, useWallet } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

/** Freelancer impulsiona um serviço seu — paga em créditos Escambo e vai pro topo da busca. */
export function BoostModal({ service, onClose }: { service: Service; onClose: () => void }) {
  const toast = useToast();
  const plans = useBoostPlans();
  const wallet = useWallet();
  const boost = useCreateBoost();
  const [planId, setPlanId] = useState<number | null>(null);
  const credits = wallet.data?.credits ?? 0;

  async function confirm(): Promise<void> {
    if (!planId) return;
    try {
      await boost.mutateAsync({ serviceId: service.id, planId });
      toast.success('Serviço impulsionado! 🚀 Ele já aparece no topo da busca.');
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao impulsionar');
    }
  }

  return (
    <Modal title={`Impulsionar: ${service.title}`} onClose={onClose}>
      <p className="muted">
        Seu serviço vai pro topo da busca pelo período do plano. Você paga com créditos Escambo — tem{' '}
        <b>{credits}</b> disponíveis.
      </p>
      <QueryState isLoading={plans.isLoading} error={plans.error} data={plans.data} onRetry={() => void plans.refetch()}>
        {(list) => (
          <div className="plan-grid" role="radiogroup" aria-label="Plano de impulsionamento">
            {list.map((p) => {
              const ok = credits >= p.costCredits;
              return (
                <label key={p.id} className={`radio-card ${planId === p.id ? 'on' : ''} ${ok ? '' : 'off'}`}>
                  <input
                    type="radio"
                    name="plan"
                    disabled={!ok}
                    checked={planId === p.id}
                    onChange={() => ok && setPlanId(p.id)}
                  />
                  🚀 {p.name}
                  <small>
                    {p.durationDays} dias · <b>{p.costCredits} créditos</b>
                    {!ok ? ' · créditos insuficientes' : ''}
                  </small>
                  {p.description && <small>{p.description}</small>}
                </label>
              );
            })}
          </div>
        )}
      </QueryState>
      <Button onClick={() => void confirm()} disabled={!planId || boost.isPending}>
        {boost.isPending ? 'Impulsionando…' : 'Confirmar impulsionamento'}
      </Button>
    </Modal>
  );
}
