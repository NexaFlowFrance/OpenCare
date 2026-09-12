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
    | 'presence'
    | 'heatwave'
    | 'visits'
    | 'care_plan';

export type WsAction = 'created' | 'updated' | 'deleted' | 'synced';

export interface WsUpdatePayload {
    type: 'update';
    entity: WsEntity;
    action: WsAction;
    circleId?: string;
}

/** Registered WebSocket connections keyed by userId */
export const clients = new Map<string, Set<WebSocket>>();

/**
 * Appareils patient (kiosk, telephone) connectes, par cercle. Ils n'ont pas
 * d'utilisateur : ils recoivent les mises a jour du cercle pour rester
 * synchronises entre eux (une prise confirmee sur la tablette s'affiche
 * aussitot sur le telephone, et inversement).
 */
export const deviceClients = new Map<string, Set<WebSocket>>();

export const registerDeviceSocket = (circleId: string, ws: WebSocket): void => {
    if (!deviceClients.has(circleId)) deviceClients.set(circleId, new Set());
    deviceClients.get(circleId)!.add(ws);
};

export const unregisterDeviceSocket = (circleId: string, ws: WebSocket): void => {
    const set = deviceClients.get(circleId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) deviceClients.delete(circleId);
};

const sendToDevices = (circleId: string, payload: WsUpdatePayload): void => {
    const set = deviceClients.get(circleId);
    if (!set) return;
    const message = JSON.stringify(payload);
    set.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
};

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
        sendToDevices(circleId, payload);
    } catch (error) {
        logger.warn('ws.broadcast_circle_failed', {
            circleId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
