import type { Service } from '@escambo/types';
import { useMemo, useState } from 'react';
import { BusinessModal } from '../../components/BusinessActions';
import { useVerifiedEmailGate } from '../../components/VerifyEmail';
import { QueryState } from '../../components/ui';
import { useCategories, useMyServices, usePublicSettings, useUpdateService } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { rootsById } from './categoryArt';
import { ServiceCard } from './ServiceCard';
import { flattenCategories, ServiceForm, type ServiceFormBody } from './ServiceForm';

/**
 * "Meus serviços" (RF-030): todos os serviços de quem está logado, pausados inclusive (a busca só
 * mostra os ativos). Daqui o dono edita (RF-022 e RF-023), pausa e reativa. Pausado não aparece na
 * busca e não recebe propostas novas (RN-013); os contratos em andamento seguem.
 */
export function MyServices({ onBoost }: { onBoost: (s: Service) => void }) {
  const mine = useMyServices();
  const update = useUpdateService();
  const toast = useToast();
  const categories = useCategories();
  const roots = useMemo(() => rootsById(categories.data ?? []), [categories.data]);
  const minPrice = usePublicSettings().data?.minServicePrice ?? 10;
  const [editing, setEditing] = useState<Service | null>(null);
  // Reativar é publicar de novo: exige e-mail confirmado (RF-006). Pausar e editar, não.
  const gate = useVerifiedEmailGate();
  const togglingId = update.isPending && !editing ? update.variables?.id : undefined;

  async function toggle(s: Service): Promise<void> {
    try {
      await update.mutateAsync({ id: s.id, body: { isActive: !s.isActive } });
      toast.success(
        s.isActive
          ? `"${s.title}" pausado: saiu da busca e não recebe propostas novas.`
          : `"${s.title}" reativado: voltou para a busca.`,
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível salvar.');
    }
  }

  async function save(id: number, body: ServiceFormBody): Promise<void> {
    try {
      await update.mutateAsync({ id, body });
      toast.success('Serviço atualizado!');
      setEditing(null);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível salvar.');
    }
  }

  return (
    <section aria-labelledby="my-services-title" className="stack">
      <h2 id="my-services-title" className="sr-only">
        Meus serviços
      </h2>
      <QueryState
        isLoading={mine.isLoading}
        error={mine.error}
        data={mine.data}
        onRetry={() => void mine.refetch()}
        isEmpty={(list) => list.length === 0}
        empty='Você ainda não publicou nenhum serviço. Use "Novo serviço" para publicar o primeiro.'
      >
        {(list) => {
          const paused = list.filter((s) => !s.isActive).length;
          return (
            <>
              <p className="muted" data-testid="my-services-count">
                {list.length === 1 ? '1 serviço' : `${list.length} serviços`}
                {paused > 0 && ` · ${paused === 1 ? '1 pausado' : `${paused} pausados`}`}
              </p>
              <div className="cards-grid">
                {list.map((s) => (
                  <ServiceCard
                    key={s.id}
                    service={s}
                    mine
                    showOwner={false}
                    categorySlug={roots.get(s.categoryId)?.slug}
                    categoryName={roots.get(s.categoryId)?.name}
                    onContratar={() => undefined}
                    onBoost={onBoost}
                    onEdit={setEditing}
                    onToggleActive={(svc) =>
                      svc.isActive
                        ? void toggle(svc)
                        : gate.guard('reativar o serviço', () => toggle(svc))
                    }
                    toggling={togglingId === s.id}
                  />
                ))}
              </div>
            </>
          );
        }}
      </QueryState>

      {editing && (
        <BusinessModal title="Editar serviço" onClose={() => setEditing(null)}>
          <ServiceForm
            initial={editing}
            categories={categories.data ? flattenCategories(categories.data) : []}
            minPrice={minPrice}
            submitLabel="Salvar alterações"
            pending={update.isPending}
            onSubmit={(body) => save(editing.id, body)}
            onCancel={() => setEditing(null)}
            className="stack"
          />
        </BusinessModal>
      )}
      {gate.dialog}
    </section>
  );
}
