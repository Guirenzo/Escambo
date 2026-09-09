import { Ban, RotateCcw, UserX } from 'lucide-react';
import { Button } from '../../components/ui';
import { useModerateUser } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

const LABEL = { suspend: 'Suspender', ban: 'Banir', reactivate: 'Reativar' } as const;

/** Moderação de usuário (admin): suspender, banir ou reativar, com confirmação. */
export function ModerationButtons({ ulid }: { ulid: string }) {
  const toast = useToast();
  const moderate = useModerateUser();

  async function run(action: keyof typeof LABEL): Promise<void> {
    if (!window.confirm(`${LABEL[action]} este usuário?`)) return;
    try {
      await moderate.mutateAsync({ ulid, action });
      toast.success(
        `Usuário ${action === 'reactivate' ? 'reativado' : action === 'ban' ? 'banido' : 'suspenso'}.`,
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro na moderação');
    }
  }

  return (
    <div className="admin-actions" aria-label="Moderação">
      <Button variant="secondary" disabled={moderate.isPending} onClick={() => void run('suspend')}>
        <UserX size={14} /> Suspender
      </Button>
      <Button variant="danger" disabled={moderate.isPending} onClick={() => void run('ban')}>
        <Ban size={14} /> Banir
      </Button>
      <Button variant="ghost" disabled={moderate.isPending} onClick={() => void run('reactivate')}>
        <RotateCcw size={14} /> Reativar
      </Button>
    </div>
  );
}
