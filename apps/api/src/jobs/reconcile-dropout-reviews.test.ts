import { beforeEach, expect, it, vi } from 'vitest';
import { runReconcileDropoutReviews } from './reconcile-dropout-reviews';
import { dropoutsService } from '../modules/dropouts/dropouts.service';

vi.mock('../modules/dropouts/dropouts.service', () => ({
  dropoutsService: { reconcilePending: vi.fn() },
}));
beforeEach(() => vi.clearAllMocks());

it('usa lote limitado e devolve o que a reconciliação confirmou', async () => {
  const result = { processed: 3, reviewsOpened: 1 };
  vi.mocked(dropoutsService.reconcilePending).mockResolvedValue(result);
  expect(await runReconcileDropoutReviews()).toEqual(result);
  expect(dropoutsService.reconcilePending).toHaveBeenCalledWith(100);
});

it('falha fica visível para o agendador e permite nova rodada', async () => {
  const failure = new Error('MySQL indisponível');
  vi.mocked(dropoutsService.reconcilePending).mockRejectedValue(failure);
  await expect(runReconcileDropoutReviews()).rejects.toBe(failure);
});
