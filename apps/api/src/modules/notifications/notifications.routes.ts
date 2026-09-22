import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import {
  getEmailPreference,
  getNotifications,
  getPushStatus,
  readAllNotifications,
  readNotification,
  subscribePush,
  testPush,
  unsubscribePush,
  updateEmailPreference,
} from './notifications.controller';

export const notificationsRoutes = Router();

notificationsRoutes.use(authenticate);
notificationsRoutes.get('/', asyncHandler(getNotifications));
notificationsRoutes.get('/preferences', asyncHandler(getEmailPreference));
notificationsRoutes.put('/preferences', asyncHandler(updateEmailPreference));
notificationsRoutes.get('/push', asyncHandler(getPushStatus));
notificationsRoutes.post('/push', asyncHandler(subscribePush));
notificationsRoutes.delete('/push', asyncHandler(unsubscribePush));
notificationsRoutes.post('/push/test', asyncHandler(testPush));
notificationsRoutes.post('/read-all', asyncHandler(readAllNotifications));
notificationsRoutes.post('/:id/read', asyncHandler(readNotification));
