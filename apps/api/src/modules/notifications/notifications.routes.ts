import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { asyncHandler } from '../../utils/async-handler';
import { getNotifications, readAllNotifications, readNotification } from './notifications.controller';

export const notificationsRoutes = Router();

notificationsRoutes.use(authenticate);
notificationsRoutes.get('/', asyncHandler(getNotifications));
notificationsRoutes.post('/read-all', asyncHandler(readAllNotifications));
notificationsRoutes.post('/:id/read', asyncHandler(readNotification));
