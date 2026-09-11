import { query } from '../db';
import { sendPushToUser } from './pushService';
import { broadcast } from './broadcaster';
import logger from './logger';

export interface CreateNotificationInput {
    /** Recipient user ID (the actual account) */
    userId: string;
    /** Care circle the notification relates to (stored for client-side filtering) */
    circleId?: string | null;
    title: string;
    message: string;
    type: string;
    relatedId?: string | null;
    /** Path the push notification should open (defaults to '/') */
    url?: string;
    /** Push tag (collapses duplicate pushes on the device); defaults to the type */
    tag?: string;
}

/**
 * Persist an in-app notification, broadcast a WebSocket refresh and send a web-push
 * message (best effort). Never throws: notification delivery must not break the
 * originating request.
 */
export async function createNotification(input: CreateNotificationInput): Promise<void> {
    try {
        await query(
            `INSERT INTO notifications (user_id, circle_id, title, message, type, related_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [input.userId, input.circleId ?? null, input.title, input.message, input.type, input.relatedId ?? null]
        );

        broadcast(input.userId, { type: 'update', entity: 'notifications', action: 'created' });

        await sendPushToUser(input.userId, {
            title: input.title,
            body: input.message,
            url: input.url ?? '/',
            tag: input.tag ?? input.type,
        });
    } catch (err) {
        logger.warn('notification.create_failed', {
            type: input.type,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
