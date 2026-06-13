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

const router = Router();

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
}

/** Validate and normalize the schedules array from the request body. */
const parseSchedules = (raw: unknown): { schedules?: ScheduleInput[]; error?: string } => {
    if (!Array.isArray(raw)) {
        return { error: 'schedules doit être un tableau' };
    }
    const schedules: ScheduleInput[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            return { error: 'Horaire de prise invalide' };
        }
        const { time_of_day, days_of_week, label } = item as Record<string, unknown>;
        if (typeof time_of_day !== 'string' || !TIME_RE.test(time_of_day)) {
            return { error: 'Heure de prise invalide (format HH:MM attendu)' };
        }
        let days: number[] = [1, 2, 3, 4, 5, 6, 7];
        if (days_of_week !== undefined && days_of_week !== null) {
            if (!Array.isArray(days_of_week) || days_of_week.length === 0
                || !days_of_week.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
                return { error: 'Jours de prise invalides (entiers de 1 à 7 attendus)' };
            }
            days = [...new Set(days_of_week as number[])].sort((a, b) => a - b);
        }
        schedules.push({
            time_of_day,
            days_of_week: days,
            label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 50) : null,
        });
    }
    return { schedules };
};

/** photo_url: only a raster image data URL (max 1.5 MB decoded) or null is accepted. */
const parsePhotoUrl = (raw: unknown): { value?: string | null; error?: string } => {
    if (raw === null || raw === undefined || raw === '') {
        return { value: null };
    }
    const match = typeof raw === 'string' ? raw.match(DATA_URL_IMAGE_RE) : null;
    if (!match) {
        return { error: 'photo_url doit être une data URL image' };
    }
    if (base64ByteSize(match[1]) > MAX_PHOTO_BYTES) {
        return { error: 'Photo trop volumineuse (1.5 Mo maximum)' };
    }
    // match implies raw is a string (the ternary above only matches on strings).
    return { value: raw as string };
};

const parseDateField = (raw: unknown, field: string): { value?: string | null; error?: string } => {
    if (raw === null || raw === undefined || raw === '') {
        return { value: null };
    }
    if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
        return { error: `${field} doit être une date au format YYYY-MM-DD` };
    }
    return { value: raw };
};

const toDateString = (d: Date): string => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
                       'label', s.label
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

/**
 * Apply a status change to an intake and keep the journal in sync.
 * taken/skipped: stamp the confirmation and create a journal entry.
 * pending: clear the confirmation and remove the linked journal entry.
 * Runs inside the caller's transaction. Returns the updated intake row.
 */
const applyIntakeStatus = async (
    client: PoolClient,
    intake: { id: string; circle_id: string; medication_id: string; journal_entry_id: string | null; medication_name: string; medication_dosage: string | null },
    status: 'taken' | 'skipped' | 'pending',
    author: { userId?: string; linkId?: string; name: string }
) => {
    // The previous journal entry (if any) no longer reflects the new state.
    if (intake.journal_entry_id) {
        await client.query('DELETE FROM journal_entries WHERE id = $1', [intake.journal_entry_id]);
    }

    if (status === 'pending') {
        const result = await client.query(
            `UPDATE medication_intakes
             SET status = 'pending', confirmed_by_user = NULL, confirmed_by_link = NULL,
                 confirmed_at = NULL, journal_entry_id = NULL
             WHERE id = $1
             RETURNING *`,
            [intake.id]
        );
        return result.rows[0];
    }

    const content = intake.medication_dosage
        ? `${intake.medication_name} ${intake.medication_dosage}`
        : intake.medication_name;

    const entryResult = await client.query(
        `INSERT INTO journal_entries (circle_id, author_user_id, caregiver_link_id, author_name, type, content, data)
         VALUES ($1, $2, $3, $4, 'medication', $5, $6)
         RETURNING id`,
        [
            intake.circle_id,
            author.userId ?? null,
            author.linkId ?? null,
            author.name,
            content,
            JSON.stringify({ medication_id: intake.medication_id, intake_id: intake.id, status }),
        ]
    );

    const result = await client.query(
        `UPDATE medication_intakes
         SET status = $1, confirmed_by_user = $2, confirmed_by_link = $3,
             confirmed_at = NOW(), journal_entry_id = $4
         WHERE id = $5
         RETURNING *`,
        [status, author.userId ?? null, author.linkId ?? null, entryResult.rows[0].id, intake.id]
    );
    return result.rows[0];
};

const fetchIntakeForUpdate = async (client: PoolClient, intakeId: string, circleId: string) => {
    const result = await client.query(
        `SELECT i.id, i.circle_id, i.medication_id, i.journal_entry_id,
                m.name AS medication_name, m.dosage AS medication_dosage
         FROM medication_intakes i
         JOIN medications m ON m.id = i.medication_id
         WHERE i.id = $1 AND i.circle_id = $2
         FOR UPDATE OF i`,
        [intakeId, circleId]
    );
    return result.rows[0];
};

// ============================================================
// Magic link (no account): confirm an intake through a caregiver link.
// Declared before the auth middleware so it stays public.
// ============================================================
router.put('/link/:linkToken/intakes/:id', caregiverLinkMiddleware, async (req: CaregiverLinkRequest, res: Response) => {
    const client = await getClient();
    try {
        const link = req.caregiverLink!;
        const { status } = req.body;

        if (!INTAKE_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, error: 'Statut invalide' });
        }

        await client.query('BEGIN');

        // The intake must belong to the circle the link gives access to.
        const intake = await fetchIntakeForUpdate(client, req.params.id, link.circle_id);
        if (!intake) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Prise introuvable' });
        }

        const updated = await applyIntakeStatus(client, intake, status, {
            linkId: link.id,
            name: link.display_name,
        });

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
    try {
        const active = typeof req.query.active === 'string' ? req.query.active : 'true';
        if (!['true', 'false', 'all'].includes(active)) {
            return res.status(400).json({ success: false, error: 'Paramètre active invalide (true, false ou all)' });
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
    const client = await getClient();
    try {
        const { name, dosage, form, instructions, prescriber, schedules } = req.body;

        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Le nom du médicament est requis' });
        }

        const photo = parsePhotoUrl(req.body.photo_url);
        if (photo.error) {
            return res.status(400).json({ success: false, error: photo.error });
        }
        const startDate = parseDateField(req.body.start_date, 'start_date');
        if (startDate.error) {
            return res.status(400).json({ success: false, error: startDate.error });
        }
        const endDate = parseDateField(req.body.end_date, 'end_date');
        if (endDate.error) {
            return res.status(400).json({ success: false, error: endDate.error });
        }

        let parsedSchedules: ScheduleInput[] = [];
        if (schedules !== undefined && schedules !== null) {
            const parsed = parseSchedules(schedules);
            if (parsed.error) {
                return res.status(400).json({ success: false, error: parsed.error });
            }
            parsedSchedules = parsed.schedules!;
        }

        await client.query('BEGIN');

        const medResult = await client.query(
            `INSERT INTO medications (circle_id, name, dosage, form, instructions, photo_url, prescriber, start_date, end_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
            ]
        );
        const medicationId = medResult.rows[0].id;

        for (const schedule of parsedSchedules) {
            await client.query(
                `INSERT INTO medication_schedules (medication_id, time_of_day, days_of_week, label)
                 VALUES ($1, $2, $3, $4)`,
                [medicationId, schedule.time_of_day, JSON.stringify(schedule.days_of_week), schedule.label]
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
router.put('/:id', requireContentWriter, async (req: CircleRequest, res: Response) => {
    const client = await getClient();
    try {
        const { schedules } = req.body;
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if ('name' in req.body) {
            if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
                return res.status(400).json({ success: false, error: 'Le nom du médicament est requis' });
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
            const photo = parsePhotoUrl(req.body.photo_url);
            if (photo.error) {
                return res.status(400).json({ success: false, error: photo.error });
            }
            fields.push(`photo_url = $${idx++}`);
            values.push(photo.value);
        }
        for (const field of ['start_date', 'end_date'] as const) {
            if (field in req.body) {
                const parsed = parseDateField(req.body[field], field);
                if (parsed.error) {
                    return res.status(400).json({ success: false, error: parsed.error });
                }
                fields.push(`${field} = $${idx++}`);
                values.push(parsed.value);
            }
        }
        if ('active' in req.body) {
            if (typeof req.body.active !== 'boolean') {
                return res.status(400).json({ success: false, error: 'active doit être un booléen' });
            }
            fields.push(`active = $${idx++}`);
            values.push(req.body.active);
        }

        let parsedSchedules: ScheduleInput[] | null = null;
        if (schedules !== undefined && schedules !== null) {
            const parsed = parseSchedules(schedules);
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
            return res.status(404).json({ success: false, error: 'Médicament introuvable' });
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
                    `INSERT INTO medication_schedules (medication_id, time_of_day, days_of_week, label)
                     VALUES ($1, $2, $3, $4)`,
                    [req.params.id, schedule.time_of_day, JSON.stringify(schedule.days_of_week), schedule.label]
                );
            }
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
    try {
        const result = await query(
            'DELETE FROM medications WHERE id = $1 AND circle_id = $2 RETURNING id',
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Médicament introuvable' });
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
    try {
        const today = toDateString(new Date());
        const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : today;
        let to = typeof req.query.to === 'string' && req.query.to ? req.query.to : from;

        if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
            return res.status(400).json({ success: false, error: 'Dates invalides (format YYYY-MM-DD attendu)' });
        }

        const fromDate = new Date(`${from}T00:00:00`);
        const toDate = new Date(`${to}T00:00:00`);
        if (toDate < fromDate) {
            return res.status(400).json({ success: false, error: 'La date de fin doit suivre la date de début' });
        }

        // Cap the period at 14 days to keep lazy generation bounded.
        const diffDays = Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
        if (diffDays >= MAX_INTAKE_RANGE_DAYS) {
            const capped = new Date(fromDate);
            capped.setDate(capped.getDate() + MAX_INTAKE_RANGE_DAYS - 1);
            to = toDateString(capped);
        }

        // Generate the missing occurrences of the period (idempotent thanks to the
        // unique constraint). Respects the medication start/end dates and the
        // schedule's days of week (ISO: 1 = Monday ... 7 = Sunday).
        await query(
            `INSERT INTO medication_intakes (circle_id, medication_id, schedule_id, due_at)
             SELECT m.circle_id, m.id, s.id, d::date + s.time_of_day
             FROM medications m
             JOIN medication_schedules s ON s.medication_id = m.id
             CROSS JOIN generate_series($2::date, $3::date, interval '1 day') AS d
             WHERE m.circle_id = $1
               AND m.active = TRUE
               AND (m.start_date IS NULL OR d::date >= m.start_date)
               AND (m.end_date IS NULL OR d::date <= m.end_date)
               AND s.days_of_week @> to_jsonb(EXTRACT(ISODOW FROM d)::int)
             ON CONFLICT (medication_id, schedule_id, due_at) DO NOTHING`,
            [req.circleId, from, to]
        );

        // Pending occurrences more than 4 hours overdue become missed.
        await query(
            `UPDATE medication_intakes
             SET status = 'missed'
             WHERE circle_id = $1 AND status = 'pending' AND due_at < NOW() - interval '4 hours'`,
            [req.circleId]
        );

        const result = await query(
            `SELECT i.id, i.circle_id, i.medication_id, i.schedule_id, i.due_at, i.status,
                    i.confirmed_by_user, i.confirmed_by_link, i.confirmed_at, i.journal_entry_id,
                    m.name AS medication_name, m.dosage AS medication_dosage,
                    s.label AS schedule_label
             FROM medication_intakes i
             JOIN medications m ON m.id = i.medication_id
             LEFT JOIN medication_schedules s ON s.id = i.schedule_id
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
    const client = await getClient();
    try {
        const { status } = req.body;
        if (!INTAKE_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, error: 'Statut invalide' });
        }

        await client.query('BEGIN');

        const intake = await fetchIntakeForUpdate(client, req.params.id, req.circleId!);
        if (!intake) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Prise introuvable' });
        }

        const userResult = await client.query('SELECT name FROM users WHERE id = $1', [req.userId]);
        const authorName = userResult.rows[0]?.name ?? 'Aidant';

        const updated = await applyIntakeStatus(client, intake, status, {
            userId: req.userId,
            name: authorName,
        });

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
    try {
        const { title, prescribed_by, reminder_days, document_id, notes } = req.body;

        if (typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ success: false, error: 'Le titre de l\'ordonnance est requis' });
        }
        const issuedDate = parseDateField(req.body.issued_date, 'issued_date');
        if (issuedDate.error) {
            return res.status(400).json({ success: false, error: issuedDate.error });
        }
        const renewalDate = parseDateField(req.body.renewal_date, 'renewal_date');
        if (renewalDate.error) {
            return res.status(400).json({ success: false, error: renewalDate.error });
        }
        if (reminder_days !== undefined && reminder_days !== null
            && (!Number.isInteger(reminder_days) || reminder_days < 0)) {
            return res.status(400).json({ success: false, error: 'reminder_days doit être un entier positif' });
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
    try {
        const fields: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if ('title' in req.body) {
            if (typeof req.body.title !== 'string' || !req.body.title.trim()) {
                return res.status(400).json({ success: false, error: 'Le titre de l\'ordonnance est requis' });
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
                const parsed = parseDateField(req.body[field], field);
                if (parsed.error) {
                    return res.status(400).json({ success: false, error: parsed.error });
                }
                fields.push(`${field} = $${idx++}`);
                values.push(parsed.value);
            }
        }
        if ('reminder_days' in req.body) {
            if (!Number.isInteger(req.body.reminder_days) || req.body.reminder_days < 0) {
                return res.status(400).json({ success: false, error: 'reminder_days doit être un entier positif' });
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
            return res.status(404).json({ success: false, error: 'Ordonnance introuvable' });
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
    try {
        const result = await query(
            'DELETE FROM prescriptions WHERE id = $1 AND circle_id = $2 RETURNING id',
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Ordonnance introuvable' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'medications', action: 'deleted' });
        res.json({ success: true });
    } catch (error) {
        console.error('Delete prescription error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
