import { WebSocket } from 'ws';
import { query } from '../db';
import logger from './logger';

export type WsEntity =
    | 'circle'
    | 'journal'
    | 'vitals'
    | 'medications'
    | 'intakes'
    | 'events'
    | 'tasks'
    | 'shopping'
    | 'messages'
    | 'documents'
    | 'contacts'
    | 'expenses'
    | 'notifications'
    | 'integrations'
    | 'notes'
    | 'presence';

export type WsAction = 'created' | 'updated' | 'deleted' | 'synced';

export interface WsUpdatePayload {
    type: 'update';
    entity: WsEntity;
    action: WsAction;
    circleId?: string;
}

/** Registered WebSocket connections keyed by userId */
export const clients = new Map<string, Set<WebSocket>>();

/** Push a real-time update to all connections of a given user */
export const broadcast = (userId: string, data: WsUpdatePayload): void => {
    const userClients = clients.get(userId);
    if (!userClients) return;

    const message = JSON.stringify(data);
    userClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
};

/**
 * Push a real-time update to every member of a circle.
 * Fire-and-forget: a broadcast failure never breaks the API call that triggered it.
 */
export const broadcastToCircle = async (circleId: string, data: Omit<WsUpdatePayload, 'circleId'>): Promise<void> => {
    try {
        const result = await query('SELECT user_id FROM circle_members WHERE circle_id = $1', [circleId]);
        const payload: WsUpdatePayload = { ...data, circleId };
        for (const row of result.rows as Array<{ user_id: string }>) {
            broadcast(row.user_id, payload);
        }
    } catch (error) {
        logger.warn('ws.broadcast_circle_failed', {
            circleId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
