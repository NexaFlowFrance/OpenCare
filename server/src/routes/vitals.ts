import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireRole, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import { createNotification } from '../lib/notifications';
import { langFromRequest, t } from '../lib/i18n';

const router = Router();

// Donnees de sante: la matrice de docs/SPEC.md exclut le role neighbor
// (lecture pour viewer, ecriture pour admin/family/professional).
router.use(authMiddleware, circleMiddleware, requireRole('admin', 'family', 'professional', 'viewer'));

const requireHealthWriter = requireRole('admin', 'family', 'professional');

const VITAL_TYPES = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];

const parseDate = (value: unknown): Date | null => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
};

// List measurements, oldest first (ready for charts).
// Optional filters: ?type=, ?from= and ?to= (bounds on measured_at), ?limit= (default 500).
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const parsedLimit = parseInt(String(req.query.limit), 10);
        const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 500 : parsedLimit, 1), 2000);

        const conditions: string[] = ['circle_id = $1'];
        const values: unknown[] = [req.circleId];
        let idx = 2;

        if (typeof req.query.type === 'string' && req.query.type) {
            if (!VITAL_TYPES.includes(req.query.type)) {
                return res.status(400).json({ success: false, error: 'Invalid vital type' });
            }
            conditions.push(`type = $${idx++}`);
            values.push(req.query.type);
        }

        if (typeof req.query.from === 'string' && req.query.from) {
            const from = parseDate(req.query.from);
            if (!from) {
                return res.status(400).json({ success: false, error: 'Invalid from date' });
            }
            conditions.push(`measured_at >= $${idx++}`);
            values.push(from);
        }

        if (typeof req.query.to === 'string' && req.query.to) {
            const to = parseDate(req.query.to);
            if (!to) {
                return res.status(400).json({ success: false, error: 'Invalid to date' });
            }
            conditions.push(`measured_at <= $${idx++}`);
            values.push(to);
        }

        values.push(limit);
        const result = await query(
            `SELECT * FROM vitals
             WHERE ${conditions.join(' AND ')}
             ORDER BY measured_at ASC
             LIMIT $${idx}`,
            values
        );

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List vitals error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Latest measurement of each type
router.get('/latest', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT DISTINCT ON (type) *
             FROM vitals
             WHERE circle_id = $1
             ORDER BY type, measured_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Latest vitals error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Record a measurement (every role except viewer)
// ============================================================
// Seuils d'alerte
// ============================================================

interface ThresholdRow {
    type: string;
    min_value: number | null;
    max_value: number | null;
    min_value2: number | null;
    max_value2: number | null;
}

/** Libelles serveur des constantes, pour le texte des notifications. */
const VITAL_LABELS: Record<string, { fr: string; en: string }> = {
    weight: { fr: 'Poids', en: 'Weight' },
    bp: { fr: 'Tension', en: 'Blood pressure' },
    pain: { fr: 'Douleur', en: 'Pain' },
    mood: { fr: 'Moral', en: 'Mood' },
    temperature: { fr: 'Température', en: 'Temperature' },
    glucose: { fr: 'Glycémie', en: 'Blood sugar' },
};

const num = (raw: unknown): number | null => {
    if (raw === null || raw === '' || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
};

/** La mesure sort-elle de la plage ? Renvoie null quand tout va bien. */
export const outOfRange = (
    threshold: ThresholdRow,
    value: number,
    value2: number | null
): 'low' | 'high' | null => {
    if (threshold.min_value !== null && value < Number(threshold.min_value)) return 'low';
    if (threshold.max_value !== null && value > Number(threshold.max_value)) return 'high';
    if (value2 !== null) {
        if (threshold.min_value2 !== null && value2 < Number(threshold.min_value2)) return 'low';
        if (threshold.max_value2 !== null && value2 > Number(threshold.max_value2)) return 'high';
    }
    return null;
};

/** Previent les admins et la famille quand une mesure sort de la plage fixee. */
async function notifyOutOfRange(
    circleId: string,
    type: string,
    value: number,
    value2: number | null,
    direction: 'low' | 'high',
    vitalId: string
): Promise<void> {
    const [{ rows: members }, { rows: recipientRows }] = await Promise.all([
        query(
            `SELECT cm.user_id, COALESCE(u.language, 'fr') AS language
             FROM circle_members cm JOIN users u ON u.id = cm.user_id
             WHERE cm.circle_id = $1 AND cm.role IN ('admin', 'family')`,
            [circleId]
        ),
        query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [circleId]),
    ]);
    const who = (recipientRows[0]?.first_name as string | undefined)?.trim() ?? '';
    const reading = value2 !== null ? `${value}/${value2}` : String(value);

    await Promise.all((members as Array<{ user_id: string; language: string }>).map((member) => {
        const lang = String(member.language).toLowerCase().startsWith('en') ? 'en' : 'fr';
        const label = VITAL_LABELS[type]?.[lang] ?? type;
        const title = lang === 'en'
            ? `${label} out of range${who ? ` for ${who}` : ''}`
            : `${label} hors de la plage${who ? ` pour ${who}` : ''}`;
        const message = lang === 'en'
            ? `Last measurement: ${reading}, ${direction === 'high' ? 'above' : 'below'} the range set for this circle.`
            : `Dernière mesure : ${reading}, ${direction === 'high' ? 'au-dessus' : 'en dessous'} de la plage définie pour ce cercle.`;
        return createNotification({
            userId: member.user_id,
            circleId,
            title,
            message,
            type: 'vital_out_of_range',
            relatedId: vitalId,
            url: '/health',
            tag: `vital-${type}-${circleId}`,
        });
    }));
}

// GET /api/vitals/thresholds : the ranges set for this circle.
router.get('/thresholds', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            'SELECT type, min_value, max_value, min_value2, max_value2 FROM vital_thresholds WHERE circle_id = $1 ORDER BY type',
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Get vital thresholds error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/vitals/thresholds : set or clear the range of one vital type.
// Body { type, min_value, max_value, min_value2, max_value2 }; a null bound is
// no bound, and a row with no bound at all is removed.
router.put('/thresholds', requireRole('admin', 'family'), async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const type = typeof req.body?.type === 'string' ? req.body.type : '';
        if (!VITAL_TYPES.includes(type)) {
            return res.status(400).json({ success: false, error: t(lang, 'vitals.thresholdType') });
        }
        const bounds = ['min_value', 'max_value', 'min_value2', 'max_value2'].map((key) => num(req.body?.[key]));
        if (bounds.some((b) => Number.isNaN(b))) {
            return res.status(400).json({ success: false, error: t(lang, 'vitals.thresholdInvalid') });
        }
        const [minV, maxV, minV2, maxV2] = bounds;
        if ((minV !== null && maxV !== null && minV >= maxV) || (minV2 !== null && maxV2 !== null && minV2 >= maxV2)) {
            return res.status(400).json({ success: false, error: t(lang, 'vitals.thresholdInvalid') });
        }

        if (bounds.every((b) => b === null)) {
            await query('DELETE FROM vital_thresholds WHERE circle_id = $1 AND type = $2', [req.circleId, type]);
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'updated' });
            return res.json({ success: true, data: null });
        }

        const result = await query(
            `INSERT INTO vital_thresholds (circle_id, type, min_value, max_value, min_value2, max_value2)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (circle_id, type) DO UPDATE
               SET min_value = EXCLUDED.min_value, max_value = EXCLUDED.max_value,
                   min_value2 = EXCLUDED.min_value2, max_value2 = EXCLUDED.max_value2,
                   updated_at = CURRENT_TIMESTAMP
             RETURNING type, min_value, max_value, min_value2, max_value2`,
            [req.circleId, type, minV, maxV, minV2, maxV2]
        );
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update vital threshold error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.post('/', requireHealthWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { type, value, value2, unit, measured_at, notes } = req.body;

        if (typeof type !== 'string' || !VITAL_TYPES.includes(type)) {
            return res.status(400).json({ success: false, error: 'Invalid vital type' });
        }

        const numValue = Number(value);
        if (value === undefined || value === null || value === '' || !Number.isFinite(numValue)) {
            return res.status(400).json({ success: false, error: 'Invalid value' });
        }

        let numValue2: number | null = null;
        if (value2 !== undefined && value2 !== null && value2 !== '') {
            numValue2 = Number(value2);
            if (!Number.isFinite(numValue2)) {
                return res.status(400).json({ success: false, error: 'Invalid value2' });
            }
        }

        let measuredAt: Date | null = null;
        if (measured_at !== undefined && measured_at !== null) {
            measuredAt = parseDate(measured_at);
            if (!measuredAt) {
                return res.status(400).json({ success: false, error: 'Invalid measured_at date' });
            }
        }

        const result = await query(
            `INSERT INTO vitals (circle_id, type, value, value2, unit, measured_at, recorded_by_user, notes)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP), $7, $8)
             RETURNING *`,
            [
                req.circleId,
                type,
                numValue,
                numValue2,
                typeof unit === 'string' && unit.trim() ? unit.trim() : null,
                measuredAt,
                req.userId,
                typeof notes === 'string' && notes.trim() ? notes.trim() : null,
            ]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'created' });

        // Hors de la plage fixee par la famille : on previent, sans bloquer la reponse.
        const thresholdResult = await query(
            'SELECT type, min_value, max_value, min_value2, max_value2 FROM vital_thresholds WHERE circle_id = $1 AND type = $2',
            [req.circleId, type]
        );
        const threshold = thresholdResult.rows[0] as ThresholdRow | undefined;
        if (threshold) {
            const direction = outOfRange(threshold, numValue, numValue2);
            if (direction) {
                await notifyOutOfRange(req.circleId!, type, numValue, numValue2, direction, result.rows[0].id);
            }
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create vital error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update a measurement: its author (recorded_by_user) or an admin
router.put('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, recorded_by_user FROM vitals WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Vital not found' });
        }
        const isAuthor = existing.rows[0].recorded_by_user === req.userId;
        if (!isAuthor && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        const { type, value, value2, unit, measured_at, notes } = req.body;
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (type !== undefined) {
            if (typeof type !== 'string' || !VITAL_TYPES.includes(type)) {
                return res.status(400).json({ success: false, error: 'Invalid vital type' });
            }
            fields.push(`type = $${idx++}`);
            values.push(type);
        }

        if (value !== undefined) {
            const numValue = Number(value);
            if (value === null || value === '' || !Number.isFinite(numValue)) {
                return res.status(400).json({ success: false, error: 'Invalid value' });
            }
            fields.push(`value = $${idx++}`);
            values.push(numValue);
        }

        if (value2 !== undefined) {
            if (value2 === null || value2 === '') {
                fields.push(`value2 = $${idx++}`);
                values.push(null);
            } else {
                const numValue2 = Number(value2);
                if (!Number.isFinite(numValue2)) {
                    return res.status(400).json({ success: false, error: 'Invalid value2' });
                }
                fields.push(`value2 = $${idx++}`);
                values.push(numValue2);
            }
        }

        if (unit !== undefined) {
            fields.push(`unit = $${idx++}`);
            values.push(typeof unit === 'string' && unit.trim() ? unit.trim() : null);
        }

        if (measured_at !== undefined) {
            const measuredAt = parseDate(measured_at);
            if (!measuredAt) {
                return res.status(400).json({ success: false, error: 'Invalid measured_at date' });
            }
            fields.push(`measured_at = $${idx++}`);
            values.push(measuredAt);
        }

        if (notes !== undefined) {
            fields.push(`notes = $${idx++}`);
            values.push(typeof notes === 'string' && notes.trim() ? notes.trim() : null);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.params.id, req.circleId);
        const result = await query(
            `UPDATE vitals SET ${fields.join(', ')} WHERE id = $${idx} AND circle_id = $${idx + 1} RETURNING *`,
            values
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update vital error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete a measurement: its author or an admin
router.delete('/:id', async (req: CircleRequest, res: Response) => {
    try {
        const existing = await query(
            'SELECT id, recorded_by_user FROM vitals WHERE id = $1 AND circle_id = $2',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Vital not found' });
        }
        const isAuthor = existing.rows[0].recorded_by_user === req.userId;
        if (!isAuthor && req.circleRole !== 'admin') {
            return res.status(403).json({ success: false, error: 'Insufficient role' });
        }

        await query('DELETE FROM vitals WHERE id = $1 AND circle_id = $2', [req.params.id, req.circleId]);

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'vitals', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete vital error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
