import { Router, Response } from 'express';
import { PoolClient } from 'pg';
import { query, getClient } from '../db';
import { authMiddleware } from '../middleware/auth';
import {
    circleMiddleware,
    requireContentWriter,
    requireJournalWriter,
    requireRole,
    caregiverLinkMiddleware,
    CircleRequest,
    CaregiverLinkRequest,
} from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';
import {
    applyIntakeStatus,
    fetchIntakeForUpdate,
    generateIntakes,
    markMissed,
    toDateString,
    INTAKE_DISPLAY_COLUMNS,
    INTAKE_DISPLAY_FROM,
} from '../lib/intakes';
import { langFromRequest, t, type Lang } from '../lib/i18n';

const router = Router();

// Unites et options de prise (memes listes que shared/src/constants.ts)
const MEDICATION_UNITS = ['tablet', 'capsule', 'ml', 'drop', 'sachet', 'patch', 'injection', 'puff', 'application', 'dose'];
const WITH_FOOD_OPTIONS = ['with', 'without', 'any'];
const MAX_QUANTITY = 99;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Strict allowlist: raster images only. SVG is excluded on purpose (stored XSS via
// embedded scripts when a data URL is rendered inline). The base64 payload is captured
// so the decoded size can be measured.
const DATA_URL_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i;
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;

/** Approximate decoded size of a base64 payload without allocating a buffer */
const base64ByteSize = (base64: string): number => {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
};
const MAX_INTAKE_RANGE_DAYS = 14;
const INTAKE_STATUSES = ['taken', 'skipped', 'pending'] as const;

interface ScheduleInput {
    time_of_day: string;
    days_of_week: number[];
    label: string | null;
    /** Combien prendre a cet horaire (1 par defaut) */
    quantity: number;
    /** Unite de la quantite, ou null (deduite de la forme a l'affichage) */
    unit: string | null;
}

/** Quantite par prise : nombre strictement positif, 2 decimales max, 99 max. */
const parseQuantity = (raw: unknown): number | null => {
    if (raw === undefined || raw === null || raw === '') return 1;
    const value = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0 || value > MAX_QUANTITY) return null;
    return Math.round(value * 100) / 100;
};

const parseUnit = (raw: unknown): string | null | undefined => {
    if (raw === undefined || raw === null || raw === '') return null;
    return typeof raw === 'string' && MEDICATION_UNITS.includes(raw) ? raw : undefined;
};

/** Validate and normalize the schedules array from the request body. */
const parseSchedules = (raw: unknown, lang: Lang): { schedules?: ScheduleInput[]; error?: string } => {
    if (!Array.isArray(raw)) {
        return { error: t(lang, 'medications.schedulesArray') };
    }
    const schedules: ScheduleInput[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            return { error: t(lang, 'medications.scheduleInvalid') };
        }
        const { time_of_day, days_of_week, label, quantity, unit } = item as Record<string, unknown>;
        if (typeof time_of_day !== 'string' || !TIME_RE.test(time_of_day)) {
            return { error: t(lang, 'medications.timeInvalid') };
        }
        const parsedQuantity = parseQuantity(quantity);
        if (parsedQuantity === null) {
            return { error: t(lang, 'medications.quantityInvalid') };
        }
        const parsedUnit = parseUnit(unit);
        if (parsedUnit === undefined) {
            return { error: t(lang, 'medications.unitInvalid') };
        }
        let days: number[] = [1, 2, 3, 4, 5, 6, 7];
        if (days_of_week !== undefined && days_of_week !== null) {
            if (!Array.isArray(days_of_week) || days_of_week.length === 0
                || !days_of_week.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
                return { error: t(lang, 'medications.daysInvalid') };
            }
            days = [...new Set(days_of_week as number[])].sort((a, b) => a - b);
        }
        schedules.push({
            time_of_day,
            days_of_week: days,
            label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 50) : null,
            quantity: parsedQuantity,
            unit: parsedUnit,
        });
    }
    return { schedules };
};

/** photo_url: only a raster image data URL (max 1.5 MB decoded) or null is accepted. */
const parsePhotoUrl = (raw: unknown, lang: Lang): { value?: string | null; error?: string } => {
    if (raw === null || raw === undefined || raw === '') {
        return { value: null };
    }
    const match = typeof raw === 'string' ? raw.match(DATA_URL_IMAGE_RE) : null;
    if (!match) {
        return { error: t(lang, 'medications.photoDataUrl') };
    }
    if (base64ByteSize(match[1]) > MAX_PHOTO_BYTES) {
        return { error: t(lang, 'medications.photoTooLarge') };
    }
    // match implies raw is a string (the ternary above only matches on strings).
    return { value: raw as string };
};

const parseDateField = (raw: unknown, field: string, lang: Lang): { value?: string | null; error?: string } => {
    if (raw === null || raw === undefined || raw === '') {
        return { value: null };
    }
    if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
        return { error: t(lang, 'medications.dateFormat', { field }) };
    }
    return { value: raw };
};

/** Champs optionnels du medicament : { valeur } ou { error }. */
const parseMedicationExtras = (body: Record<string, unknown>, lang: Lang): {
    values?: { prn?: boolean; with_food?: string | null; reason?: string | null; appearance?: string | null };
    error?: string;
} => {
    const values: { prn?: boolean; with_food?: string | null; reason?: string | null; appearance?: string | null } = {};
    if ('prn' in body) {
        if (typeof body.prn !== 'boolean') return { error: t(lang, 'medications.prnBoolean') };
        values.prn = body.prn;
    }
    if ('with_food' in body) {
        const raw = body.with_food;
        if (raw === null || raw === '' || raw === undefined) values.with_food = null;
        else if (typeof raw === 'string' && WITH_FOOD_OPTIONS.includes(raw)) values.with_food = raw;
        else return { error: t(lang, 'medications.withFoodInvalid') };
    }
    for (const field of ['reason', 'appearance'] as const) {
        if (field in body) {
            const raw = body[field];
            values[field] = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 500) : null;
        }
    }
    return { values };
};

const MEDICATION_WITH_SCHEDULES = `
    SELECT m.*,
           COALESCE(
               json_agg(
                   json_build_object(
                       'id', s.id,
                       'medication_id', s.medication_id,
                       'time_of_day', to_char(s.time_of_day, 'HH24:MI'),
                       'days_of_week', s.days_of_week,
                       'label', s.label,
                       'quantity', s.quantity,
                       'unit', s.unit
                   ) ORDER BY s.time_of_day
               ) FILTER (WHERE s.id IS NOT NULL),
               '[]'
           ) AS schedules
    FROM medications m
    LEFT JOIN medication_schedules s ON s.medication_id = m.id`;

const fetchMedicationWithSchedules = async (client: PoolClient, medicationId: string) => {
    const result = await client.query(
        `${MEDICATION_WITH_SCHEDULES} WHERE m.id = $1 GROUP BY m.id`,
        [medicationId]
    );
    return result.rows[0];
};

// applyIntakeStatus / fetchIntakeForUpdate live in ../lib/intakes (shared with
// the kiosk and the patient phone).

// ============================================================
// Magic link (no account): confirm an intake through a caregiver link.
// Declared before the auth middleware so it stays public.
// ============================================================
router.put('/link/:linkToken/intakes/:id', caregiverLinkMiddleware, async (req: CaregiverLinkRequest, res: Response) => {
    const lang = langFromRequest(req);
    const client = await getClient();
    try {
        const link = req.caregiverLink!;
        const { status } = req.body;

        if (!INTAKE_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, error: t(lang, 'medications.statusInvalid') });
        }

        await client.query('BEGIN');

        // The intake must belong to the circle the link gives access to.
        const intake = await fetchIntakeForUpdate(client, req.params.id, link.circle_id);
        if (!intake) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: t(lang, 'medications.intakeNotFound') });
        }

        const updated = await applyIntakeStatus(client, intake, status, {
            linkId: link.id,
            name: link.display_name,
        }, 'link');

        await client.query('COMMIT');

        await broadcastToCircle(link.circle_id, { type: 'update', entity: 'intakes', action: 'updated' });
        await broadcastToCircle(link.circle_id, { type: 'update', entity: 'journal', action: 'updated' });
        res.json({ success: true, data: updated });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Link confirm intake error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// All routes below require a logged-in member of the active circle.
// Donnees medicales: la matrice de docs/SPEC.md exclut le role neighbor
// (les intervenants de confiance sans compte passent par le lien magique ci-dessus).
router.use(authMiddleware, circleMiddleware, requireRole('admin', 'family', 'professional', 'viewer'));

// ============================================================
// Medications
// ============================================================

// List the circle's medications with their schedules. ?active=true|false|all (default true)
router.get('/', async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const active = typeof req.query.active === 'string' ? req.query.active : 'true';
        if (!['true', 'false', 'all'].includes(active)) {
            return res.status(400).json({ success: false, error: t(lang, 'medications.activeParam') });
        }

        const conditions = ['m.circle_id = $1'];
        const values: unknown[] = [req.circleId];
        if (active !== 'all') {
            conditions.push(`m.active = $2`);
            values.push(active === 'true');
        }

        const result = await query(
            `${MEDICATION_WITH_SCHEDULES}
             WHERE ${conditions.join(' AND ')}
             GROUP BY m.id
             ORDER BY m.name`,
            values
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List medications error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create a medication with its schedules (admin and family)
router.post('/', requireContentWriter, async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    const client = await getClient();
    try {
        const { name, dosage, form, instructions, prescriber, schedules } = req.body;

        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ success: false, error: t(lang, 'medications.nameRequired') });
        }

        const photo = parsePhotoUrl(req.body.photo_url, lang);
        if (photo.error) {
            return res.status(400).json({ success: false, error: photo.error });
        }
        const startDate = parseDateField(req.body.start_date, 'start_date', lang);
        if (startDate.error) {
            return res.status(400).json({ success: false, error: startDate.error });
        }
        const endDate = parseDateField(req.body.end_date, 'end_date', lang);
        if (endDate.error) {
            return res.status(400).json({ success: false, error: endDate.error });
        }
        const extras = parseMedicationExtras(req.body as Record<string, unknown>, lang);
        if (extras.error) {
            return res.status(400).json({ success: false, error: extras.error });
        }
        const prn = extras.values?.prn === true;

        // "Si besoin" medications have no schedule: occurrences are logged on demand.
        let parsedSchedules: ScheduleInput[] = [];
        if (!prn && schedules !== undefined && schedules !== null) {
            const parsed = parseSchedules(schedules, lang);
            if (parsed.error) {
                return res.status(400).json({ success: false, error: parsed.error });
            }
            parsedSchedules = parsed.schedules!;
        }

        await client.query('BEGIN');

        const medResult = await client.query(
            `INSERT INTO medications (circle_id, name, dosage, form, instructions, photo_url, prescriber, start_date, end_date,
                                      prn, with_food, reason, appearance)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING id`,
            [
                req.circleId,
                name.trim(),
                typeof dosage === 'string' && dosage.trim() ? dosage.trim() : null,
                typeof form === 'string' && form.trim() ? form.trim() : null,
                typeof instructions === 'string' && instructions.trim() ? instructions.trim() : null,
                photo.value,
                typeof prescriber === 'string' && prescriber.trim() ? prescriber.trim() : null,
                startDate.value,
                endDate.value,
                prn,
                extras.values?.with_food ?? null,
                extras.values?.reason ?? null,
                extras.values?.appearance ?? null,
            ]
        );
        const medicationId = medResult.rows[0].id;

        for (const schedule of parsedSchedules) {
            await client.query(
                `INSERT INTO medication_schedules (medication_id, time_of_day, days_of_week, label, quantity, unit)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [medicationId, schedule.time_of_day, JSON.stringify(schedule.days_of_week), schedule.label, schedule.quantity, schedule.unit]
            );
        }

        const medication = await fetchMedicationWithSchedules(client, medicationId);
        await client.query('COMMIT');

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'medications', action: 'created' });
        res.json({ success: true, data: medication });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create medication error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Update a medication; if schedules is provided, replace them all (admin and family)
// PUT /api/medications/:id/stock : set the remaining stock and the refill
// threshold, both in the unit of a dose. Either can be null to stop tracking.
router.put('/:id/stock', requireContentWriter, async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const parseAmount = (raw: unknown): { value?: number | null; error?: string } => {
            if (raw === null || raw === '' || raw === undefined) return { value: null };
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0 || n > 100000) return { error: t(lang, 'medications.stockInvalid') };
            return { value: Math.round(n * 100) / 100 };
        };

        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;
        for (const [key, column] of [['stock_quantity', 'stock_quantity'], ['stock_alert_threshold', 'stock_alert_threshold']] as const) {
            if (!(key in req.body)) continue;
            const parsed = parseAmount(req.body[key]);
            if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
            fields.push(`${column} = $${idx++}`);
            values.push(parsed.value);
        }
        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: t(lang, 'medications.stockRequired') });
        }
        fields.push('stock_updated_at = CURRENT_TIMESTAMP');
        values.push(req.params.id, req.circleId);

        const result = await query(
            `UPDATE medications SET ${fields.join(', ')} WHERE id = $${idx++} AND circle_id = $${idx} RETURNING *`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: t(lang, 'medications.notFound') });
        }
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'medications', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update medication stock error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.put('/:id', requireContentWriter, async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    const client = await getClient();
    try {
        const { schedules } = req.body;
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if ('name' in req.body) {
            if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
                return res.status(400).json({ success: false, error: t(lang, 'medications.nameRequired') });
            }
            fields.push(`name = $${idx++}`);
            values.push(req.body.name.trim());
        }
        for (const field of ['dosage', 'form', 'instructions', 'prescriber'] as const) {
            if (field in req.body) {
                const value = req.body[field];
                fields.push(`${field} = $${idx++}`);
                values.push(typeof value === 'string' && value.trim() ? value.trim() : null);
            }
        }
        if ('photo_url' in req.body) {
            const photo = parsePhotoUrl(req.body.photo_url, lang);
            if (photo.error) {
                return res.status(400).json({ success: false, error: photo.error });
            }
            fields.push(`photo_url = $${idx++}`);
            values.push(photo.value);
        }
        for (const field of ['start_date', 'end_date'] as const) {
            if (field in req.body) {
                const parsed = parseDateField(req.body[field], field, lang);
                if (parsed.error) {
                    return res.status(400).json({ success: false, error: parsed.error });
                }
                fields.push(`${field} = $${idx++}`);
                values.push(parsed.value);
            }
        }
        if ('active' in req.body) {
            if (typeof req.body.active !== 'boolean') {
                return res.status(400).json({ success: false, error: t(lang, 'medications.activeBoolean') });
            }
            fields.push(`active = $${idx++}`);
            values.push(req.body.active);
        }
        const extras = parseMedicationExtras(req.body as Record<string, unknown>, lang);
        if (extras.error) {
            return res.status(400).json({ success: false, error: extras.error });
        }
        for (const [field, value] of Object.entries(extras.values ?? {})) {
            fields.push(`${field} = $${idx++}`);
            values.push(value);
        }

        let parsedSchedules: ScheduleInput[] | null = null;
        if (extras.values?.prn === true) {
            // Switching to "as needed" drops the fixed schedule.
            parsedSchedules = [];
        } else if (schedules !== undefined && schedules !== null) {
            const parsed = parseSchedules(schedules, lang);
            if (parsed.error) {
                return res.status(400).json({ success: false, error: parsed.error });
            }
            parsedSchedules = parsed.schedules!;
        }

        if (fields.length === 0 && parsedSchedules === null) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        await client.query('BEGIN');

        const existing = await client.query(
            'SELECT id FROM medications WHERE id = $1 AND circle_id = $2 FOR UPDATE',
            [req.params.id, req.circleId]
        );
        if (existing.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: t(lang, 'medications.notFound') });
        }

        if (fields.length > 0) {
            values.push(req.params.id, req.circleId);
            await client.query(
                `UPDATE medications SET ${fields.join(', ')} WHERE id = $${idx} AND circle_id = $${idx + 1}`,
                values
            );
        }

        if (parsedSchedules !== null) {
            await client.query('DELETE FROM medication_schedules WHERE medication_id = $1', [req.params.id]);
            for (const schedule of parsedSchedules) {
                await client.query(
                    `INSERT INTO medication_schedules (medication_id, time_of_day, days_of_week, label, quantity, unit)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [req.params.id, schedule.time_of_day, JSON.stringify(schedule.days_of_week), schedule.label, schedule.quantity, schedule.unit]
                );
            }
            // Pending occurrences of today and later no longer match the new
            // schedule: drop them so they are regenerated (confirmed ones stay).
            await client.query(
                `DELETE FROM medication_intakes
                 WHERE medication_id = $1 AND status = 'pending' AND due_at >= date_trunc('day', NOW())`,
                [req.params.id]
            );
        }

        const medication = await fetchMedicationWithSchedules(client, req.params.id);
        await client.query('COMMIT');

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'medications', action: 'updated' });
        res.json({ success: true, data: medication });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Update medication error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Delete a medication (admin and family). Cascades to schedules and intakes.
router.delete('/:id', requireContentWriter, async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const result = await query(
            'DELETE FROM medications WHERE id = $1 AND circle_id = $2 RETURNING id',
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: t(lang, 'medications.notFound') });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'medications', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete medication error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Intakes (occurrences)
// ============================================================

// List intakes between from and to (default: today), lazily generating
// the missing occurrences of the period from the active medications' schedules.
router.get('/intakes', async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const today = toDateString(new Date());
        const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : today;
        let to = typeof req.query.to === 'string' && req.query.to ? req.query.to : from;

        if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
            return res.status(400).json({ success: false, error: t(lang, 'medications.datesInvalid') });
        }

        const fromDate = new Date(`${from}T00:00:00`);
        const toDate = new Date(`${to}T00:00:00`);
        if (toDate < fromDate) {
            return res.status(400).json({ success: false, error: t(lang, 'medications.endBeforeStart') });
        }

        // Cap the period at 14 days to keep lazy generation bounded.
        const diffDays = Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
        if (diffDays >= MAX_INTAKE_RANGE_DAYS) {
            const capped = new Date(fromDate);
            capped.setDate(capped.getDate() + MAX_INTAKE_RANGE_DAYS - 1);
            to = toDateString(capped);
        }

        // Generate the missing occurrences of the period (idempotent), then flag
        // the overdue ones (shared with the kiosk: ../lib/intakes).
        await generateIntakes(req.circleId!, from, to);
        await markMissed(req.circleId!);

        const result = await query(
            `SELECT ${INTAKE_DISPLAY_COLUMNS}
             ${INTAKE_DISPLAY_FROM}
             WHERE i.circle_id = $1
               AND i.due_at >= $2::date
               AND i.due_at < $3::date + interval '1 day'
             ORDER BY i.due_at, m.name`,
            [req.circleId, from, to]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List intakes error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Confirm, skip or reset an intake (everyone except viewers)
router.put('/intakes/:id', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    const client = await getClient();
    try {
        const { status } = req.body;
        if (!INTAKE_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, error: t(lang, 'medications.statusInvalid') });
        }

        await client.query('BEGIN');

        const intake = await fetchIntakeForUpdate(client, req.params.id, req.circleId!);
        if (!intake) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: t(lang, 'medications.intakeNotFound') });
        }

        const userResult = await client.query('SELECT name FROM users WHERE id = $1', [req.userId]);
        const authorName = userResult.rows[0]?.name ?? 'Aidant';

        const updated = await applyIntakeStatus(client, intake, status, {
            userId: req.userId,
            name: authorName,
        }, 'caregiver');

        await client.query('COMMIT');

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'intakes', action: 'updated' });
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'updated' });
        res.json({ success: true, data: updated });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Update intake error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Log an ad-hoc dose of an "as needed" medication (no schedule): creates a
// taken intake dated now. Body { quantity?: number }.
router.post('/:id/intakes', requireJournalWriter, async (req: CircleRequest, res: Response) => {
    const client = await getClient();
    const lang = langFromRequest(req);
    try {
        const quantity = parseQuantity(req.body?.quantity);
        if (quantity === null) {
            return res.status(400).json({ success: false, error: t(lang, 'medications.quantityInvalid') });
        }

        await client.query('BEGIN');
        const medResult = await client.query(
            `SELECT id, name, dosage, form, prn, active FROM medications WHERE id = $1 AND circle_id = $2 FOR UPDATE`,
            [req.params.id, req.circleId]
        );
        const med = medResult.rows[0];
        if (!med) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: t(lang, 'medications.notFound') });
        }

        const inserted = await client.query(
            `INSERT INTO medication_intakes (circle_id, medication_id, schedule_id, due_at, status, quantity)
             VALUES ($1, $2, NULL, NOW(), 'pending', $3)
             RETURNING id`,
            [req.circleId, med.id, quantity]
        );
        const intake = await fetchIntakeForUpdate(client, inserted.rows[0].id, req.circleId!);
        const userResult = await client.query('SELECT name FROM users WHERE id = $1', [req.userId]);
        const updated = await applyIntakeStatus(client, intake!, 'taken', {
            userId: req.userId,
            name: userResult.rows[0]?.name ?? 'Aidant',
        }, 'caregiver');
        await client.query('COMMIT');

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'intakes', action: 'created' });
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'created' });
        res.json({ success: true, data: updated });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Log intake error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// ============================================================
// Prescriptions
// ============================================================

const PRESCRIPTION_FIELDS = `id, circle_id, title, prescribed_by, issued_date, renewal_date,
    reminder_days, document_id, notes, created_at, updated_at`;

// List prescriptions, soonest renewal first
router.get('/prescriptions', async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT ${PRESCRIPTION_FIELDS}
             FROM prescriptions
             WHERE circle_id = $1
             ORDER BY renewal_date ASC NULLS LAST, created_at DESC`,
            [req.circleId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('List prescriptions error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create a prescription (admin and family)
router.post('/prescriptions', requireContentWriter, async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const { title, prescribed_by, reminder_days, document_id, notes } = req.body;

        if (typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ success: false, error: t(lang, 'medications.prescriptionTitleRequired') });
        }
        const issuedDate = parseDateField(req.body.issued_date, 'issued_date', lang);
        if (issuedDate.error) {
            return res.status(400).json({ success: false, error: issuedDate.error });
        }
        const renewalDate = parseDateField(req.body.renewal_date, 'renewal_date', lang);
        if (renewalDate.error) {
            return res.status(400).json({ success: false, error: renewalDate.error });
        }
        if (reminder_days !== undefined && reminder_days !== null
            && (!Number.isInteger(reminder_days) || reminder_days < 0)) {
            return res.status(400).json({ success: false, error: t(lang, 'medications.reminderDays') });
        }

        const result = await query(
            `INSERT INTO prescriptions (circle_id, title, prescribed_by, issued_date, renewal_date, reminder_days, document_id, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING ${PRESCRIPTION_FIELDS}`,
            [
                req.circleId,
                title.trim(),
                typeof prescribed_by === 'string' && prescribed_by.trim() ? prescribed_by.trim() : null,
                issuedDate.value,
                renewalDate.value,
                reminder_days ?? 7,
                document_id || null,
                typeof notes === 'string' && notes.trim() ? notes.trim() : null,
            ]
        );

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'medications', action: 'created' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Create prescription error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update a prescription (admin and family)
router.put('/prescriptions/:id', requireContentWriter, async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if ('title' in req.body) {
            if (typeof req.body.title !== 'string' || !req.body.title.trim()) {
                return res.status(400).json({ success: false, error: t(lang, 'medications.prescriptionTitleRequired') });
            }
            fields.push(`title = $${idx++}`);
            values.push(req.body.title.trim());
        }
        for (const field of ['prescribed_by', 'notes'] as const) {
            if (field in req.body) {
                const value = req.body[field];
                fields.push(`${field} = $${idx++}`);
                values.push(typeof value === 'string' && value.trim() ? value.trim() : null);
            }
        }
        for (const field of ['issued_date', 'renewal_date'] as const) {
            if (field in req.body) {
                const parsed = parseDateField(req.body[field], field, lang);
                if (parsed.error) {
                    return res.status(400).json({ success: false, error: parsed.error });
                }
                fields.push(`${field} = $${idx++}`);
                values.push(parsed.value);
            }
        }
        if ('reminder_days' in req.body) {
            if (!Number.isInteger(req.body.reminder_days) || req.body.reminder_days < 0) {
                return res.status(400).json({ success: false, error: t(lang, 'medications.reminderDays') });
            }
            fields.push(`reminder_days = $${idx++}`);
            values.push(req.body.reminder_days);
        }
        if ('document_id' in req.body) {
            fields.push(`document_id = $${idx++}`);
            values.push(req.body.document_id || null);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, error: 'No changes provided' });
        }

        values.push(req.params.id, req.circleId);
        const result = await query(
            `UPDATE prescriptions SET ${fields.join(', ')}
             WHERE id = $${idx} AND circle_id = $${idx + 1}
             RETURNING ${PRESCRIPTION_FIELDS}`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: t(lang, 'medications.prescriptionNotFound') });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'medications', action: 'updated' });
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Update prescription error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Delete a prescription (admin and family)
router.delete('/prescriptions/:id', requireContentWriter, async (req: CircleRequest, res: Response) => {
    const lang = langFromRequest(req);
    try {
        const result = await query(
            'DELETE FROM prescriptions WHERE id = $1 AND circle_id = $2 RETURNING id',
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: t(lang, 'medications.prescriptionNotFound') });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'medications', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete prescription error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
