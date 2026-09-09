import { Download, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, QueryState } from '../../components/ui';
import { dtm } from '../../lib/format';
import {
  useDeletionRequests,
  useExportRequests,
  useRequestDeletion,
  useRequestExport,
} from '../../lib/hooks';
import { useToast } from '../../lib/toast';

const STATUS: Record<string, string> = {
  pending: 'pendente',
  processing: 'em processamento',
  completed: 'concluída',
  done: 'concluída',
  rejected: 'recusada',
  cancelled: 'cancelada',
};

/** Direitos do titular (LGPD): exportar meus dados e pedir a exclusão da conta. */
export function PrivacidadeCard() {
  const toast = useToast();
  const exports = useExportRequests();
  const deletions = useDeletionRequests();
  const requestExport = useRequestExport();
  const requestDeletion = useRequestDeletion();

  async function onExport(): Promise<void> {
    try {
      await requestExport.mutateAsync();
      toast.success('Exportação solicitada. Você será avisado quando o arquivo estiver pronto.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao solicitar exportação');
    }
  }

  async function onDelete(): Promise<void> {
    if (
      !window.confirm(
        'Pedir a exclusão da sua conta e dos seus dados? Isso é analisado pela plataforma e não pode ser desfeito depois de concluído.',
      )
    )
      return;
    try {
      await requestDeletion.mutateAsync(null);
      toast.success('Exclusão solicitada. Você receberá a confirmação por e-mail.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao solicitar exclusão');
    }
  }

  const pendingDeletion = deletions.data?.some((d) => d.status === 'pending') ?? false;

  return (
    <section className="card wide">
      <div className="card-head">
        <h3>
          <ShieldCheck size={16} /> Privacidade e dados (LGPD)
        </h3>
      </div>
      <p className="muted tiny">
        Você pode pedir uma cópia de tudo que o Escambo guarda sobre você, e pedir a exclusão da
        conta. As solicitações ficam registradas aqui com o status.
      </p>
      <div className="two-col">
        <div className="stack">
          <Button
            variant="secondary"
            onClick={() => void onExport()}
            disabled={requestExport.isPending}
          >
            <Download size={14} /> Solicitar exportação dos meus dados
          </Button>
          <QueryState
            isLoading={exports.isLoading}
            error={exports.error}
            data={exports.data}
            empty="Nenhuma exportação solicitada."
            onRetry={() => void exports.refetch()}
          >
            {(list) => (
              <ul className="req-list" aria-label="Exportações solicitadas">
                {list.map((r) => (
                  <li key={r.id}>
                    <span>Exportação · {dtm(r.createdAt)}</span>
                    <span className="pill">{STATUS[r.status] ?? r.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </div>
        <div className="stack">
          <Button
            variant="danger"
            onClick={() => void onDelete()}
            disabled={requestDeletion.isPending || pendingDeletion}
          >
            <Trash2 size={14} />{' '}
            {pendingDeletion ? 'Exclusão em análise' : 'Solicitar exclusão da conta'}
          </Button>
          <QueryState
            isLoading={deletions.isLoading}
            error={deletions.error}
            data={deletions.data}
            empty="Nenhuma exclusão solicitada."
            onRetry={() => void deletions.refetch()}
          >
            {(list) => (
              <ul className="req-list" aria-label="Exclusões solicitadas">
                {list.map((r) => (
                  <li key={r.id}>
                    <span>Exclusão · {dtm(r.createdAt)}</span>
                    <span className="pill">{STATUS[r.status] ?? r.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </div>
      </div>
    </section>
  );
}
