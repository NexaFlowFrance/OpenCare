import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireContentWriter, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import logger from '../lib/logger';

// Suivi canicule / fortes chaleurs, rattache au cercle actif (X-Circle-Id).
// L'episode est declenche manuellement par un admin/family (pas de source meteo
// externe: offline-first). Pendant un episode actif, le scheduler pousse des
// rappels d'hydratation aux aidants (reminderScheduler.ts) et le kiosk affiche
// un bandeau + un bouton "J'ai bu de l'eau".
const router = Router();
router.use(authMiddleware, circleMiddleware);

const LEVELS = ['orange', 'red'] as const;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_REMINDERS = 6;

// activated_at est un TIMESTAMP: le parseur pg (db.ts) le renvoie deja en naif
// 'YYYY-MM-DDTHH:mm:ss', donc pas de to_char ici.
const FIELDS = 'circle_id, enabled, active, level, reminder_times, activated_at';

/** Garde uniquement des HH:MM valides, dedupliques, tries, plafonnes. */
const cleanTimes = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of raw) {
        if (typeof value !== 'string') continue;
        const time = value.trim();
        if (!TIME_RE.test(time) || seen.has(time)) continue;
        seen.add(time);
        out.push(time);
    }
    out.sort();
    return out.slice(0, MAX_REMINDERS);
};

/** Lit la config du cercle, en creant une ligne par defaut au premier acces. */
async function getOrCreate(circleId: string) {
    const existing = await query(`SELECT ${FIELDS} FROM heatwave_settings WHERE circle_id = $1`, [circleId]);
    if (existing.rows.length > 0) return existing.rows[0];

    const inserted = await query(
        `INSERT INTO heatwave_settings (circle_id) VALUES ($1)
         ON CONFLICT (circle_id) DO NOTHING
         RETURNING ${FIELDS}`,
        [circleId]
    );
    if (inserted.rows.length > 0) return inserted.rows[0];

    // Course entre deux requetes concurrentes: la ligne existe deja, on la relit.
    const reread = await query(`SELECT ${FIELDS} FROM heatwave_settings WHERE circle_id = $1`, [circleId]);
    return reread.rows[0];
}

// GET /api/heatwave : config + etat de l'episode (tous les membres du cercle)
router.get('/', async (req: CircleRequest, res: Response) => {
    try {
        const data = await getOrCreate(req.circleId!);
        res.json({ success: true, data });
    } catch (error) {
        logger.error('heatwave.get_error', { error: error instanceof Error ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/heatwave : reglages (activation de la fonction + creneaux) (admin/family)
router.put('/', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { enabled, reminder_times } = req.body as { enabled?: unknown; reminder_times?: unknown };
        const times = cleanTimes(reminder_times);

        const result = await query(
            `INSERT INTO heatwave_settings (circle_id, enabled, reminder_times)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (circle_id) DO UPDATE SET
               enabled = EXCLUDED.enabled,
               reminder_times = EXCLUDED.reminder_times,
               updated_at = NOW()
             RETURNING ${FIELDS}`,
            [req.circleId, Boolean(enabled), JSON.stringify(times)]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'heatwave', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        logger.error('heatwave.update_error', { error: error instanceof Error ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/heatwave/toggle : declenche ou clot un episode (admin/family).
// Declencher force enabled=TRUE (pour que le scheduler prenne le relais).
router.post('/toggle', requireContentWriter, async (req: CircleRequest, res: Response) => {
    try {
        const { active, level } = req.body as { active?: unknown; level?: unknown };
        const isActive = active === true;
        const chosenLevel = (LEVELS as readonly string[]).includes(level as string) ? (level as string) : 'orange';

        const result = await query(
            `INSERT INTO heatwave_settings (circle_id, enabled, active, level, activated_at, activated_by)
             VALUES ($1, TRUE, $2, $3,
                     CASE WHEN $2 THEN NOW() ELSE NULL END,
                     CASE WHEN $2 THEN $4::uuid ELSE NULL END)
             ON CONFLICT (circle_id) DO UPDATE SET
               active = EXCLUDED.active,
               level = EXCLUDED.level,
               enabled = CASE WHEN EXCLUDED.active THEN TRUE ELSE heatwave_settings.enabled END,
               activated_at = CASE WHEN EXCLUDED.active THEN NOW() ELSE NULL END,
               activated_by = CASE WHEN EXCLUDED.active THEN EXCLUDED.activated_by ELSE NULL END,
               updated_at = NOW()
             RETURNING ${FIELDS}`,
            [req.circleId, isActive, chosenLevel, req.userId]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'heatwave', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        logger.error('heatwave.toggle_error', { error: error instanceof Error ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
