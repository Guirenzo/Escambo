import { HardDrive, Trash2 } from 'lucide-react';
import { Button, QueryState } from '../../components/ui';
import { dtm, formatBytes } from '../../lib/format';
import { useAdminStorage, usePurgeAttachments } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

/**
 * Uso do volume da API (anexos do chat e cópias LGPD) e o expurgo (ADR 31): o que está no
 * disco, o que já saiu, o que está inconsistente, e um botão para rodar agora.
 */
export function StorageSection() {
  const storage = useAdminStorage();
  const purge = usePurgeAttachments();
  const toast = useToast();

  async function runNow(): Promise<void> {
    try {
      const r = await purge.mutateAsync();
      toast.success(
        `Expurgo concluído: ${r.purged} anexo(s) removido(s), ${r.orphansRemoved} órfão(s)` +
          (r.failed ? `, ${r.failed} falha(s)` : '') +
          '.',
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível rodar o expurgo');
    }
  }

  return (
    <section className="card wide" aria-labelledby="storage-title" data-testid="storage-card">
      <div className="card-head">
        <h3 id="storage-title">
          <HardDrive size={16} /> Armazenamento
        </h3>
        <Button
          variant="secondary"
          className="mini"
          onClick={() => void runNow()}
          disabled={purge.isPending}
        >
          <Trash2 size={14} /> {purge.isPending ? 'Rodando…' : 'Rodar expurgo agora'}
        </Button>
      </div>
      <QueryState
        isLoading={storage.isLoading}
        error={storage.error}
        data={storage.data}
        onRetry={() => void storage.refetch()}
      >
        {(s) => (
          <>
            <dl className="storage-grid">
              <div>
                <dt>Anexos no disco</dt>
                <dd>
                  {s.attachments.active} · {formatBytes(s.attachments.activeBytes)}
                </dd>
              </div>
              <div>
                <dt>Pasta de uploads</dt>
                <dd>
                  {s.uploads.files} arquivo(s) · {formatBytes(s.uploads.bytes)}
                </dd>
              </div>
              <div>
                <dt>Cópias LGPD</dt>
                <dd>
                  {s.exports.files} arquivo(s) · {formatBytes(s.exports.bytes)}
                </dd>
              </div>
              <div>
                <dt>Fotos e portfólio</dt>
                <dd>
                  {s.media.files} imagem(ns) · {formatBytes(s.media.bytes)}
                </dd>
              </div>
              <div>
                <dt>Já removidos</dt>
                <dd>
                  {s.attachments.purged}
                  <span className="muted tiny">
                    {' '}
                    ({s.attachments.purged30d} nos últimos 30 dias)
                  </span>
                </dd>
              </div>
              <div
                className={
                  s.attachments.missing || s.attachments.orphans || s.media.orphans ? 'warn' : ''
                }
              >
                <dt>Inconsistências</dt>
                <dd>
                  {s.attachments.missing} sem arquivo · {s.attachments.orphans + s.media.orphans}{' '}
                  órfão(s)
                </dd>
              </div>
              <div>
                <dt>Retenção</dt>
                <dd>
                  {s.retentionDays} dias
                  <span className="muted tiny"> · expurgo diário às {s.purgeHour}h</span>
                </dd>
              </div>
            </dl>
            <p className="muted tiny" data-testid="storage-last-purge">
              {s.lastPurge
                ? `Último expurgo ${dtm(s.lastPurge.at)} (${s.lastPurge.trigger === 'admin' ? 'pelo admin' : 'pelo job'}): ${s.lastPurge.purged} anexo(s), ${s.lastPurge.orphansRemoved} órfão(s).`
                : 'Nenhum expurgo rodou ainda.'}{' '}
              Anexos com mais de {s.retentionDays} dias em conversas sem contratação aberta saem do
              disco; a mensagem fica e diz por quê.
            </p>
          </>
        )}
      </QueryState>
    </section>
  );
}
