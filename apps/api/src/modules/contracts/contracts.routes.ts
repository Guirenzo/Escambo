import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { uploadRateLimiter } from '../../middlewares/rate-limit';
import { requireVerifiedEmail } from '../../middlewares/require-verified-email';
import { fileArray } from '../../middlewares/upload';
import { asyncHandler } from '../../utils/async-handler';
import { agreeDropout } from '../dropouts/dropouts.controller';
import {
  acceptContract,
  acceptCounterOffer,
  approveContract,
  approveMilestone,
  cancelContract,
  createContract,
  counterOffer,
  deliverContract,
  deliverMilestone,
  getContract,
  grantRevisionContract,
  grantMilestoneRevision,
  listContracts,
  rejectContract,
  requestMilestoneRevision,
  requestExtension,
  requestRevisionContract,
  resolveExtension,
} from './contracts.controller';
import { DELIVERY_MAX_FILES, DELIVERY_MAX_TOTAL_BYTES } from './delivery-files';

export const contractsRoutes = Router();

/**
 * Entrega com arquivos (RF-035): multipart com a mensagem, os links (`files`, repetido) e até
 * DELIVERY_MAX_FILES arquivos em `attachments`, cada um no limite do anexo do chat. Só o envio com
 * arquivo conta no teto de anexos por IP; a entrega em JSON segue como antes.
 */
const deliveryUpload: RequestHandler[] = [
  (req, res, next) => (req.is('multipart/form-data') ? uploadRateLimiter(req, res, next) : next()),
  fileArray('attachments', {
    maxCount: DELIVERY_MAX_FILES,
    maxTotalBytes: DELIVERY_MAX_TOTAL_BYTES,
    // mensagem + até 20 links, e a mensagem pode ser longa
    fields: 25,
    fieldBytes: 20_000,
  }),
];

// Toda contratação exige login.
contractsRoutes.use(authenticate);

// Contratar exige e-mail confirmado (RF-006). Responder ao que já existe (aceitar, recusar,
// contrapropor, entregar, aprovar, disputar), não.
contractsRoutes.post('/', requireVerifiedEmail, asyncHandler(createContract));
contractsRoutes.get('/', asyncHandler(listContracts));
contractsRoutes.get('/:id', asyncHandler(getContract));

// Negociação (RN-030): quem tem a vez contrapropõe; o cliente aceita a oferta par.
contractsRoutes.post('/:id/offers', asyncHandler(counterOffer));
contractsRoutes.post('/:id/offers/:seq/accept', asyncHandler(acceptCounterOffer));

// Transições da máquina de estados (o service valida quem pode fazer o quê)
contractsRoutes.post('/:id/accept', asyncHandler(acceptContract));
contractsRoutes.post('/:id/reject', asyncHandler(rejectContract));
contractsRoutes.post('/:id/deliver', ...deliveryUpload, asyncHandler(deliverContract));
contractsRoutes.post('/:id/approve', asyncHandler(approveContract));
contractsRoutes.post('/:id/request-revision', asyncHandler(requestRevisionContract));
contractsRoutes.post('/:id/revisions/grant', asyncHandler(grantRevisionContract));
contractsRoutes.post('/:id/cancel', asyncHandler(cancelContract));
contractsRoutes.post('/:id/dropout/agreed', asyncHandler(agreeDropout));

// Prazo (RN-028): o freelancer pede uma única extensão; o cliente aceita ou recusa.
contractsRoutes.post('/:id/extension', asyncHandler(requestExtension));
contractsRoutes.post('/:id/extension/:decision', asyncHandler(resolveExtension));

// Escrow por marcos (RN-069): entrega, aprovação (libera só aquele marco) e revisão por marco.
contractsRoutes.post(
  '/:id/milestones/:milestoneId/deliver',
  ...deliveryUpload,
  asyncHandler(deliverMilestone),
);
contractsRoutes.post('/:id/milestones/:milestoneId/approve', asyncHandler(approveMilestone));
contractsRoutes.post(
  '/:id/milestones/:milestoneId/request-revision',
  asyncHandler(requestMilestoneRevision),
);
contractsRoutes.post(
  '/:id/milestones/:milestoneId/revisions/grant',
  asyncHandler(grantMilestoneRevision),
);
