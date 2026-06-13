import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireAdmin, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import logger from '../lib/logger';

// Veille passive sans caméra: Home Assistant pousse des signaux de présence
// (capteur de porte, prise de la cafetière, détecteur de mouvement) sur un
// webhook public authentifié par token. Le token est stocké dans
// care_circles.settings JSONB sous la clé 'presence_webhook_token'.

const router = Router();

const SIGNAL_KINDS = ['motion', 'door', 'power', 'other'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const SETTINGS_TOKEN_KEY = 'presence_webhook_token';

const webhookPath = (circleId: string, token: string): string =>
    `/api/presence/webhook/${circleId}/${token}`;

/** Constant-time token comparison (hash first: inputs can differ in length). */
const safeTokenEqual = (expected: string, provided: string): boolean => {
    const a = crypto.createHash('sha256').update(expected).digest();
    const b = crypto.createHash('sha256').update(provided).digest();
    return crypto.timingSafeEqual(a, b);
};

/** Stored webhook token of a circle, or null when none was generated yet. */
async function loadWebhookToken(circleId: string): Promise<string | null> {
    const result = await query(
        `SELECT settings ->> '${SETTINGS_TOKEN_KEY}' AS token FROM care_circles WHERE id = $1`,
        [circleId]
    );
    const token = result.rows[0]?.token as string | null | undefined;
    return token || null;
}

// ============================================================
// PUBLIC webhook: called by a Home Assistant automation (rest_command).
// No JWT: the long random token in the URL is the credential.
// MUST stay declared before router.use(authMiddleware).
// ============================================================
router.post('/webhook/:circleId/:webhookToken', async (req: Request, res: Response) => {
    try {
        const { circleId, webhookToken } = req.params;
        if (!UUID_RE.test(circleId) || typeof webhookToken !== 'string' || webhookToken.length < 16) {
            return res.status(404).json({ success: false, error: 'Unknown webhook' });
        }

        const expected = await loadWebhookToken(circleId);
        if (!expected || !safeTokenEqual(expected, webhookToken)) {
            // Same answer whether the circle or the token is wrong: no enumeration.
            return res.status(404).json({ success: false, error: 'Unknown webhook' });
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const source = typeof body.source === 'string' ? body.source.trim().slice(0, 100) : '';
        if (!source) {
            return res.status(400).json({ success: false, error: 'source is required' });
        }
        const kind = typeof body.kind === 'string' && (SIGNAL_KINDS as readonly string[]).includes(body.kind)
            ? body.kind
            : 'other';
        const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
            ? body.payload
            : {};

        await query(
            `INSERT INTO presence_signals (circle_id, source, kind, payload)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [circleId, source, kind, JSON.stringify(payload)]
        );

        await broadcastToCircle(circleId, { type: 'update', entity: 'presence', action: 'created' });
        res.json({ success: true });
    } catch (error) {
        logger.error('presence.webhook_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Authenticated routes (member of the active circle)
// ============================================================
router.use(authMiddleware);
router.use(circleMiddleware);

const RULE_FIELDS = `id, enabled, to_char(no_activity_before, 'HH24:MI') AS no_activity_before,
                     alert_member_ids, last_alert_date`;

// GET /api/presence/status : today's activity summary + rule + webhook URL
router.get('/status', async (req: CircleRequest, res: Response) => {
    try {
        const [countResult, lastResult, ruleResult, token] = await Promise.all([
            query(
                `SELECT COUNT(*)::int AS count FROM presence_signals
                 WHERE circle_id = $1 AND occurred_at >= date_trunc('day', CURRENT_TIMESTAMP)`,
                [req.circleId]
            ),
            query(
                `SELECT source, kind, occurred_at FROM presence_signals
                 WHERE circle_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
                [req.circleId]
            ),
            query(`SELECT ${RULE_FIELDS} FROM presence_rules WHERE circle_id = $1`, [req.circleId]),
            loadWebhookToken(req.circleId!),
        ]);

        const todayCount = (countResult.rows[0]?.count as number) ?? 0;
        res.json({
            success: true,
            data: {
                today_signal_count: todayCount,
                last_signal: lastResult.rows[0] ?? null,
                normal_activity: todayCount > 0,
                rule: ruleResult.rows[0] ?? null,
                webhook_url: token ? webhookPath(req.circleId!, token) : null,
            },
        });
    } catch (error) {
        logger.error('presence.status_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/presence/signals : last 50 signals of the circle
router.get('/signals', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT id, source, kind, payload, occurred_at FROM presence_signals
             WHERE circle_id = $1 ORDER BY occurred_at DESC LIMIT 50`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        logger.error('presence.signals_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/presence/rule : upsert the circle's alert rule (admin)
router.put('/rule', requireAdmin, async (req: CircleRequest, res: Response) => {
    try {
        const { enabled, no_activity_before, alert_member_ids } = req.body as {
            enabled?: unknown;
            no_activity_before?: unknown;
            alert_member_ids?: unknown;
        };

        if (typeof no_activity_before !== 'string' || !TIME_RE.test(no_activity_before)) {
            return res.status(400).json({ success: false, error: 'no_activity_before must be HH:MM' });
        }

        // Keep only ids that really are members of this circle.
        const requestedIds = Array.isArray(alert_member_ids)
            ? alert_member_ids.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))
            : [];
        let memberIds: string[] = [];
        if (requestedIds.length > 0) {
            const membersResult = await query(
                'SELECT id FROM circle_members WHERE circle_id = $1 AND id = ANY($2::uuid[])',
                [req.circleId, requestedIds]
            );
            memberIds = (membersResult.rows as Array<{ id: string }>).map((row) => row.id);
        }

        const result = await query(
            `INSERT INTO presence_rules (circle_id, enabled, no_activity_before, alert_member_ids)
             VALUES ($1, $2, $3::time, $4::jsonb)
             ON CONFLICT (circle_id) DO UPDATE SET
               enabled = EXCLUDED.enabled,
               no_activity_before = EXCLUDED.no_activity_before,
               alert_member_ids = EXCLUDED.alert_member_ids,
               updated_at = NOW()
             RETURNING ${RULE_FIELDS}`,
            [req.circleId, Boolean(enabled), no_activity_before, JSON.stringify(memberIds)]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'presence', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        logger.error('presence.rule_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/presence/webhook-token : generate or rotate the webhook token (admin)
router.post('/webhook-token', requireAdmin, async (req: CircleRequest, res: Response) => {
    try {
        const token = crypto.randomBytes(24).toString('hex');
        await query(
            `UPDATE care_circles
             SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{${SETTINGS_TOKEN_KEY}}', to_jsonb($2::text))
             WHERE id = $1`,
            [req.circleId, token]
        );
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'presence', action: 'updated' });
        res.json({ success: true, data: { webhook_url: webhookPath(req.circleId!, token) } });
    } catch (error) {
        logger.error('presence.token_error', {
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
