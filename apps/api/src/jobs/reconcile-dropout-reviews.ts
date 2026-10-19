import { dropoutsService } from '../modules/dropouts/dropouts.service';

/** Reprocessa eventos duráveis cujo cancelamento já foi confirmado (RN-026 / ADR 61). */
export async function runReconcileDropoutReviews() {
  return dropoutsService.reconcilePending(100);
}
