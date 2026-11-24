/**
 * Rotas HTTP das contratações (camada de rota). O routes.ts monta este Router em /contracts e o
 * app.ts põe tudo sob /api: as URLs ficam /api/contracts, /api/contracts/:id/accept etc.
 * Pra que serve: liga cada método e URL a uma função do controller, com os middlewares que a
 * rota precisa na frente (login, e-mail confirmado, limite e leitura dos arquivos da entrega).
 * Com quem conversa: a rota chama o controller (contracts.controller.ts), que chama o service
 * (contracts.service.ts), que chama o repository (contracts.repository.ts), que fala com o MySQL.
 * O que tem dentro: deliveryUpload (multipart da entrega), criar, listar e ver, a negociação
 * (RN-030), as transições da máquina de estados, o pedido de prazo (RN-028) e os marcos (RN-069).
 * Nenhuma rota recebe o id de quem pede: ele vem do token, pelo authenticate (P9).
 */
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

// O Router do Express: um grupo de rotas que o routes.ts pendura em /contracts.
export const contractsRoutes = Router();

/**
 * Entrega com arquivos (RF-035): multipart com a mensagem, os links (`files`, repetido) e até
 * DELIVERY_MAX_FILES arquivos em `attachments`, cada um no limite do anexo do chat. Só o envio com
 * arquivo conta no teto de anexos por IP; a entrega em JSON segue como antes.
 */
// São dois middlewares em sequência: o limite de envios por IP (só no multipart) e o
// fileArray, que lê os arquivos para req.files com teto de quantidade e de tamanho total.
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
// O authenticate confere o token e preenche req.user; o controller tira dali o uid de quem pede.
contractsRoutes.use(authenticate);

// asyncHandler: se a função async do controller lançar erro, ele vai para o error-handler,
// que monta a resposta (404, 409, 422...). Assim nenhum controller precisa de try/catch.
// Contratar exige e-mail confirmado (RF-006). Responder ao que já existe (aceitar, recusar,
// contrapropor, entregar, aprovar, disputar), não.
contractsRoutes.post('/', requireVerifiedEmail, asyncHandler(createContract));
// Lista e detalhe: só as contratações de quem está logado (o filtro fica no service e no
// repository, P9).
contractsRoutes.get('/', asyncHandler(listContracts));
contractsRoutes.get('/:id', asyncHandler(getContract));

// Negociação (RN-030): quem tem a vez contrapropõe; o cliente aceita a oferta par.
contractsRoutes.post('/:id/offers', asyncHandler(counterOffer));
contractsRoutes.post('/:id/offers/:seq/accept', asyncHandler(acceptCounterOffer));

// Transições da máquina de estados (o service valida quem pode fazer o quê)
// accept e reject: o freelancer responde à proposta; deliver: o freelancer entrega; approve:
// o cliente aprova e libera o escrow; request-revision e revisions/grant: revisões (RN-023);
// cancel: o cliente cancela ou o freelancer desiste (RN-025, RN-026).
contractsRoutes.post('/:id/accept', asyncHandler(acceptContract));
contractsRoutes.post('/:id/reject', asyncHandler(rejectContract));
contractsRoutes.post('/:id/deliver', ...deliveryUpload, asyncHandler(deliverContract));
contractsRoutes.post('/:id/approve', asyncHandler(approveContract));
contractsRoutes.post('/:id/request-revision', asyncHandler(requestRevisionContract));
contractsRoutes.post('/:id/revisions/grant', asyncHandler(grantRevisionContract));
contractsRoutes.post('/:id/cancel', asyncHandler(cancelContract));
// O cliente concorda com a desistência do freelancer (RN-026); quem trata é o módulo dropouts.
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
