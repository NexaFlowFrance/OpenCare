import { Router, Response } from 'express';
import { getClient, query } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireAdmin, CircleRequest } from '../middleware/circle';
import { broadcastToCircle } from '../lib/broadcaster';

/**
 * Per-circle export/import (admin only).
 *
 * Export: a versioned JSON document { version: 'opencare-1', exported_at, data }
 * containing every table of the active circle.
 *
 * Import: rows are inserted into the CURRENT circle with brand new ids; an
 * old id -> new id mapping is kept for internal references (medication_id in
 * schedules/intakes, journal_entry_id, document_id, schedule_id, entry_id).
 * References to accounts (users) are kept only when the account exists on this
 * server, otherwise nulled. References to circle members (expenses, task
 * assignments...) are kept only when the member id exists in the current
 * circle, otherwise the row is skipped or the reference dropped.
 *
 * Note: this is a JSON export. Files on disk (journal photos, documents) are
 * not bundled; their file_path values are preserved as-is.
 */

const EXPORT_VERSION = 'opencare-1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asArray = (value: unknown): any[] => (Array.isArray(value) ? value : []);

const oneOf = (value: unknown, allowed: readonly string[], fallback: string): string =>
    typeof value === 'string' && allowed.includes(value) ? value : fallback;

const textOrNull = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'string' ? value : String(value);
};

const numberOrNull = (value: unknown): number | null => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const boolOr = (value: unknown, fallback: boolean): boolean =>
    value === undefined || value === null ? fallback : Boolean(value);

const tsOrNow = (value: unknown): unknown => value ?? new Date();

const JOURNAL_TYPES = ['visit', 'note', 'vital', 'medication', 'incident', 'mood'] as const;
const VITAL_TYPES = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'] as const;
const INTAKE_STATUSES = ['pending', 'taken', 'skipped', 'missed'] as const;
const EVENT_CATEGORIES = ['visit', 'medical', 'nurse', 'aide', 'other'] as const;
const DOCUMENT_CATEGORIES = ['prescription', 'report', 'insurance', 'legal', 'other'] as const;
const MESSAGE_CHANNELS = ['circle', 'dm'] as const;
const SPLIT_MODES = ['equal', 'custom'] as const;
const AID_TYPES = ['apa', 'cesu', 'tax_credit', 'other'] as const;

const router = Router();
router.use(authMiddleware);
router.use(circleMiddleware);
router.use(requireAdmin);

// Export every table of the active circle as a versioned JSON document
router.get('/export', async (req: CircleRequest, res: Response) => {
    try {
        const circleId = req.circleId!;
        const byCircle = (table: string) =>
            query(`SELECT * FROM ${table} WHERE circle_id = $1`, [circleId]);

        const [
            careRecipients,
            recipientStories,
            journalEntries,
            journalPhotos,
            vitals,
            medications,
            medicationSchedules,
            medicationIntakes,
            prescriptions,
            events,
            tasks,
            shoppingItems,
            circleNotes,
            messages,
            documents,
            contacts,
            expenses,
            expenseSettlements,
            aidRecords,
        ] = await Promise.all([
            byCircle('care_recipients'),
            byCircle('recipient_stories'),
            byCircle('journal_entries'),
            query(
                `SELECT p.* FROM journal_photos p
                 JOIN journal_entries e ON e.id = p.entry_id
                 WHERE e.circle_id = $1`,
                [circleId]
            ),
            byCircle('vitals'),
            byCircle('medications'),
            query(
                `SELECT s.* FROM medication_schedules s
                 JOIN medications m ON m.id = s.medication_id
                 WHERE m.circle_id = $1`,
                [circleId]
            ),
            byCircle('medication_intakes'),
            byCircle('prescriptions'),
            byCircle('events'),
            byCircle('tasks'),
            byCircle('shopping_items'),
            byCircle('circle_notes'),
            byCircle('messages'),
            byCircle('documents'),
            byCircle('contacts'),
            byCircle('expenses'),
            byCircle('expense_settlements'),
            byCircle('aid_records'),
        ]);

        res.json({
            success: true,
            data: {
                version: EXPORT_VERSION,
                exported_at: new Date().toISOString(),
                data: {
                    care_recipients: careRecipients.rows,
                    recipient_stories: recipientStories.rows,
                    journal_entries: journalEntries.rows,
                    journal_photos: journalPhotos.rows,
                    vitals: vitals.rows,
                    medications: medications.rows,
                    medication_schedules: medicationSchedules.rows,
                    medication_intakes: medicationIntakes.rows,
                    prescriptions: prescriptions.rows,
                    events: events.rows,
                    tasks: tasks.rows,
                    shopping_items: shoppingItems.rows,
                    circle_notes: circleNotes.rows,
                    messages: messages.rows,
                    documents: documents.rows,
                    contacts: contacts.rows,
                    expenses: expenses.rows,
                    expense_settlements: expenseSettlements.rows,
                    aid_records: aidRecords.rows,
                },
            },
        });
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Import a versioned export into the CURRENT circle, with new ids everywhere
router.post('/import', async (req: CircleRequest, res: Response) => {
    const circleId = req.circleId!;
    const doc = req.body;

    if (!doc || typeof doc !== 'object' || doc.version !== EXPORT_VERSION
        || !doc.data || typeof doc.data !== 'object') {
        return res.status(400).json({
            success: false,
            error: `Invalid import file: expected version "${EXPORT_VERSION}"`,
        });
    }

    const data = doc.data as Record<string, unknown>;
    const client = await getClient();

    const imported: Record<string, number> = {};
    const skipped: Record<string, number> = {};
    const bump = (record: Record<string, number>, table: string) => {
        record[table] = (record[table] ?? 0) + 1;
    };

    // Old id -> new id maps for internal references
    const journalMap = new Map<string, string>();
    const documentMap = new Map<string, string>();
    const medicationMap = new Map<string, string>();
    const scheduleMap = new Map<string, string>();

    // Account references survive only if the user exists on this server
    const userExistsCache = new Map<string, boolean>();
    const userOrNull = async (value: unknown): Promise<string | null> => {
        if (typeof value !== 'string' || !UUID_RE.test(value)) return null;
        if (!userExistsCache.has(value)) {
            const result = await client.query('SELECT 1 FROM users WHERE id = $1', [value]);
            userExistsCache.set(value, result.rows.length > 0);
        }
        return userExistsCache.get(value) ? value : null;
    };

    const mapOrNull = (map: Map<string, string>, value: unknown): string | null =>
        typeof value === 'string' && map.has(value) ? map.get(value)! : null;

    const insert = async (table: string, cols: string[], vals: unknown[]): Promise<string> => {
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        const result = await client.query(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
            vals
        );
        return result.rows[0].id as string;
    };

    try {
        await client.query('BEGIN');

        // Member references (expenses, assignments) only make sense if the
        // member id exists in the current circle (typical restore scenario).
        const membersResult = await client.query(
            'SELECT id FROM circle_members WHERE circle_id = $1', [circleId]
        );
        const circleMemberIds = new Set<string>(membersResult.rows.map((r: any) => r.id));
        const filterMemberIds = (value: unknown): string[] =>
            asArray(value).filter((id) => typeof id === 'string' && circleMemberIds.has(id));

        // 1. care_recipients: one per circle, upsert onto the existing profile
        const recipient = asArray(data.care_recipients)[0];
        if (recipient && typeof recipient.first_name === 'string' && recipient.first_name.trim()) {
            const cols = ['first_name', 'last_name', 'birth_date', 'photo_url', 'address', 'phone',
                'blood_type', 'allergies', 'medical_history', 'mobility_notes', 'diet_notes',
                'social_security_number', 'insurance_info', 'advance_directives',
                'gp_name', 'gp_phone', 'notes'];
            const vals = [recipient.first_name.trim(), ...cols.slice(1).map((c) => textOrNull(recipient[c]))];
            await client.query(
                `INSERT INTO care_recipients (circle_id, ${cols.join(', ')})
                 VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
                 ON CONFLICT (circle_id) DO UPDATE SET
                 ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
                [circleId, ...vals]
            );
            bump(imported, 'care_recipients');
        } else if (recipient) {
            bump(skipped, 'care_recipients');
        }

        // 2. recipient_stories: one per circle, upsert
        const story = asArray(data.recipient_stories)[0];
        if (story) {
            await client.query(
                `INSERT INTO recipient_stories (circle_id, sections, updated_by)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (circle_id) DO UPDATE SET
                 sections = EXCLUDED.sections, updated_by = EXCLUDED.updated_by`,
                [circleId, JSON.stringify(story.sections ?? []), await userOrNull(story.updated_by)]
            );
            bump(imported, 'recipient_stories');
        }

        // 3. documents (before journal/prescriptions/expenses which reference them)
        for (const row of asArray(data.documents)) {
            if (typeof row?.title !== 'string' || !row.title.trim() || typeof row?.file_path !== 'string' || !row.file_path) {
                bump(skipped, 'documents');
                continue;
            }
            const newId = await insert('documents',
                ['circle_id', 'title', 'category', 'file_path', 'mime_type', 'size_bytes', 'uploaded_by', 'notes', 'created_at'],
                [circleId, row.title, oneOf(row.category, DOCUMENT_CATEGORIES, 'other'), row.file_path,
                    textOrNull(row.mime_type), numberOrNull(row.size_bytes),
                    await userOrNull(row.uploaded_by), textOrNull(row.notes), tsOrNow(row.created_at)]
            );
            if (typeof row.id === 'string') documentMap.set(row.id, newId);
            bump(imported, 'documents');
        }

        // 4. journal_entries (caregiver_link refs are dropped: links are not exported)
        for (const row of asArray(data.journal_entries)) {
            if (!row?.occurred_at) {
                bump(skipped, 'journal_entries');
                continue;
            }
            const newId = await insert('journal_entries',
                ['circle_id', 'author_user_id', 'author_name', 'type', 'content', 'data', 'occurred_at', 'created_at', 'updated_at'],
                [circleId, await userOrNull(row.author_user_id),
                    (typeof row.author_name === 'string' && row.author_name.trim()) ? row.author_name.slice(0, 100) : 'Import',
                    oneOf(row.type, JOURNAL_TYPES, 'note'),
                    typeof row.content === 'string' ? row.content : '',
                    JSON.stringify(row.data ?? {}),
                    row.occurred_at, tsOrNow(row.created_at), tsOrNow(row.updated_at)]
            );
            if (typeof row.id === 'string') journalMap.set(row.id, newId);
            bump(imported, 'journal_entries');
        }

        // 5. journal_photos (entry_id remapped; the photo files themselves are not in the JSON)
        for (const row of asArray(data.journal_photos)) {
            const entryId = mapOrNull(journalMap, row?.entry_id);
            if (!entryId || typeof row?.file_path !== 'string' || !row.file_path) {
                bump(skipped, 'journal_photos');
                continue;
            }
            await insert('journal_photos',
                ['entry_id', 'file_path', 'mime_type', 'size_bytes', 'created_at'],
                [entryId, row.file_path, textOrNull(row.mime_type), numberOrNull(row.size_bytes), tsOrNow(row.created_at)]
            );
            bump(imported, 'journal_photos');
        }

        // 6. vitals
        for (const row of asArray(data.vitals)) {
            const value = numberOrNull(row?.value);
            if (value === null || !VITAL_TYPES.includes(row?.type)) {
                bump(skipped, 'vitals');
                continue;
            }
            await insert('vitals',
                ['circle_id', 'type', 'value', 'value2', 'unit', 'measured_at', 'journal_entry_id', 'recorded_by_user', 'notes', 'created_at'],
                [circleId, row.type, value, numberOrNull(row.value2), textOrNull(row.unit),
                    row.measured_at ?? tsOrNow(row.created_at),
                    mapOrNull(journalMap, row.journal_entry_id),
                    await userOrNull(row.recorded_by_user),
                    textOrNull(row.notes), tsOrNow(row.created_at)]
            );
            bump(imported, 'vitals');
        }

        // 7. medications
        for (const row of asArray(data.medications)) {
            if (typeof row?.name !== 'string' || !row.name.trim()) {
                bump(skipped, 'medications');
                continue;
            }
            const newId = await insert('medications',
                ['circle_id', 'name', 'dosage', 'form', 'instructions', 'photo_url', 'prescriber', 'start_date', 'end_date', 'active', 'created_at', 'updated_at'],
                [circleId, row.name, textOrNull(row.dosage), textOrNull(row.form), textOrNull(row.instructions),
                    textOrNull(row.photo_url), textOrNull(row.prescriber), row.start_date ?? null, row.end_date ?? null,
                    boolOr(row.active, true), tsOrNow(row.created_at), tsOrNow(row.updated_at)]
            );
            if (typeof row.id === 'string') medicationMap.set(row.id, newId);
            bump(imported, 'medications');
        }

        // 8. medication_schedules (medication_id remapped)
        for (const row of asArray(data.medication_schedules)) {
            const medicationId = mapOrNull(medicationMap, row?.medication_id);
            if (!medicationId || !row?.time_of_day) {
                bump(skipped, 'medication_schedules');
                continue;
            }
            const newId = await insert('medication_schedules',
                ['medication_id', 'time_of_day', 'days_of_week', 'label', 'created_at'],
                [medicationId, row.time_of_day,
                    JSON.stringify(Array.isArray(row.days_of_week) ? row.days_of_week : [1, 2, 3, 4, 5, 6, 7]),
                    textOrNull(row.label), tsOrNow(row.created_at)]
            );
            if (typeof row.id === 'string') scheduleMap.set(row.id, newId);
            bump(imported, 'medication_schedules');
        }

        // 9. medication_intakes (medication_id, schedule_id, journal_entry_id remapped)
        for (const row of asArray(data.medication_intakes)) {
            const medicationId = mapOrNull(medicationMap, row?.medication_id);
            if (!medicationId || !row?.due_at) {
                bump(skipped, 'medication_intakes');
                continue;
            }
            // ON CONFLICT: UNIQUE(medication_id, schedule_id, due_at) protects
            // against duplicated rows inside the import file itself.
            const result = await client.query(
                `INSERT INTO medication_intakes
                 (circle_id, medication_id, schedule_id, due_at, status, confirmed_by_user, confirmed_at, journal_entry_id, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (medication_id, schedule_id, due_at) DO NOTHING`,
                [circleId, medicationId, mapOrNull(scheduleMap, row.schedule_id), row.due_at,
                    oneOf(row.status, INTAKE_STATUSES, 'pending'),
                    await userOrNull(row.confirmed_by_user), row.confirmed_at ?? null,
                    mapOrNull(journalMap, row.journal_entry_id), tsOrNow(row.created_at)]
            );
            bump((result.rowCount ?? 0) > 0 ? imported : skipped, 'medication_intakes');
        }

        // 10. prescriptions (document_id remapped)
        for (const row of asArray(data.prescriptions)) {
            if (typeof row?.title !== 'string' || !row.title.trim()) {
                bump(skipped, 'prescriptions');
                continue;
            }
            await insert('prescriptions',
                ['circle_id', 'title', 'prescribed_by', 'issued_date', 'renewal_date', 'reminder_days', 'document_id', 'notes', 'created_at', 'updated_at'],
                [circleId, row.title, textOrNull(row.prescribed_by), row.issued_date ?? null, row.renewal_date ?? null,
                    numberOrNull(row.reminder_days) ?? 7, mapOrNull(documentMap, row.document_id),
                    textOrNull(row.notes), tsOrNow(row.created_at), tsOrNow(row.updated_at)]
            );
            bump(imported, 'prescriptions');
        }

        // 11. events (caldav_uid is dropped to avoid unique collisions on restore;
        //     a later CalDAV sync will relink them)
        for (const row of asArray(data.events)) {
            if (typeof row?.title !== 'string' || !row.title.trim() || !row?.start_time) {
                bump(skipped, 'events');
                continue;
            }
            await insert('events',
                ['circle_id', 'title', 'description', 'category', 'start_time', 'end_time', 'location', 'rrule',
                    'member_ids', 'reminder_30min', 'reminder_1hour', 'notes', 'created_by', 'created_at', 'updated_at'],
                [circleId, row.title, textOrNull(row.description), oneOf(row.category, EVENT_CATEGORIES, 'other'),
                    row.start_time, row.end_time ?? null, textOrNull(row.location), textOrNull(row.rrule),
                    JSON.stringify(filterMemberIds(row.member_ids)),
                    boolOr(row.reminder_30min, false), boolOr(row.reminder_1hour, false),
                    textOrNull(row.notes), await userOrNull(row.created_by),
                    tsOrNow(row.created_at), tsOrNow(row.updated_at)]
            );
            bump(imported, 'events');
        }

        // 12. tasks (assigned_to filtered to members of the current circle)
        for (const row of asArray(data.tasks)) {
            if (typeof row?.title !== 'string' || !row.title.trim()) {
                bump(skipped, 'tasks');
                continue;
            }
            await insert('tasks',
                ['circle_id', 'title', 'description', 'category', 'is_completed', 'due_date', 'frequency', 'priority',
                    'assigned_to', 'completed_at', 'completed_by', 'created_at', 'updated_at'],
                [circleId, row.title, textOrNull(row.description),
                    typeof row.category === 'string' && row.category ? row.category : 'other',
                    boolOr(row.is_completed, false), row.due_date ?? null,
                    textOrNull(row.frequency), textOrNull(row.priority),
                    JSON.stringify(filterMemberIds(row.assigned_to)),
                    row.completed_at ?? null, await userOrNull(row.completed_by),
                    tsOrNow(row.created_at), tsOrNow(row.updated_at)]
            );
            bump(imported, 'tasks');
        }

        // 13. shopping_items
        for (const row of asArray(data.shopping_items)) {
            if (typeof row?.name !== 'string' || !row.name.trim()) {
                bump(skipped, 'shopping_items');
                continue;
            }
            await insert('shopping_items',
                ['circle_id', 'name', 'category', 'quantity', 'unit', 'is_checked', 'notes', 'added_by', 'created_at', 'updated_at'],
                [circleId, row.name,
                    typeof row.category === 'string' && row.category ? row.category : 'other',
                    numberOrNull(row.quantity), textOrNull(row.unit), boolOr(row.is_checked, false),
                    textOrNull(row.notes), await userOrNull(row.added_by),
                    tsOrNow(row.created_at), tsOrNow(row.updated_at)]
            );
            bump(imported, 'shopping_items');
        }

        // 14. circle_notes
        for (const row of asArray(data.circle_notes)) {
            if (typeof row?.content !== 'string' || !row.content.trim()) {
                bump(skipped, 'circle_notes');
                continue;
            }
            await insert('circle_notes',
                ['circle_id', 'author_name', 'content', 'color', 'expires_at', 'created_at'],
                [circleId,
                    (typeof row.author_name === 'string' && row.author_name.trim()) ? row.author_name.slice(0, 100) : 'Import',
                    row.content.slice(0, 500),
                    typeof row.color === 'string' && row.color ? row.color : 'yellow',
                    row.expires_at ?? null, tsOrNow(row.created_at)]
            );
            bump(imported, 'circle_notes');
        }

        // 15. messages (author account must exist: author_user_id is NOT NULL)
        for (const row of asArray(data.messages)) {
            const authorId = await userOrNull(row?.author_user_id);
            if (!authorId || typeof row?.content !== 'string' || !row.content) {
                bump(skipped, 'messages');
                continue;
            }
            await insert('messages',
                ['circle_id', 'channel', 'author_user_id', 'recipient_user_id', 'content', 'attachments', 'edited_at', 'created_at'],
                [circleId, oneOf(row.channel, MESSAGE_CHANNELS, 'circle'), authorId,
                    await userOrNull(row.recipient_user_id), row.content,
                    JSON.stringify(asArray(row.attachments)), row.edited_at ?? null, tsOrNow(row.created_at)]
            );
            bump(imported, 'messages');
        }

        // 16. contacts
        for (const row of asArray(data.contacts)) {
            if (typeof row?.name !== 'string' || !row.name.trim()) {
                bump(skipped, 'contacts');
                continue;
            }
            await insert('contacts',
                ['circle_id', 'name', 'category', 'organization', 'phone', 'phone2', 'email', 'address', 'has_key', 'notes', 'created_at', 'updated_at'],
                [circleId, row.name,
                    typeof row.category === 'string' && row.category ? row.category : 'other',
                    textOrNull(row.organization), textOrNull(row.phone), textOrNull(row.phone2),
                    textOrNull(row.email), textOrNull(row.address), boolOr(row.has_key, false),
                    textOrNull(row.notes), tsOrNow(row.created_at), tsOrNow(row.updated_at)]
            );
            bump(imported, 'contacts');
        }

        // 17. expenses (paid_by must be a member of the current circle;
        //     document_id remapped; splits kept as-is, see TODO below)
        for (const row of asArray(data.expenses)) {
            const amount = numberOrNull(row?.amount);
            if (amount === null || !row?.date
                || typeof row?.paid_by !== 'string' || !circleMemberIds.has(row.paid_by)) {
                bump(skipped, 'expenses');
                continue;
            }
            // TODO: splits entries may reference member ids that left the
            // circle; the balance computation must ignore unknown members.
            await insert('expenses',
                ['circle_id', 'paid_by', 'amount', 'category', 'description', 'date', 'document_id', 'split_mode', 'splits', 'created_at', 'updated_at'],
                [circleId, row.paid_by, amount,
                    typeof row.category === 'string' && row.category ? row.category : 'other',
                    textOrNull(row.description), row.date, mapOrNull(documentMap, row.document_id),
                    oneOf(row.split_mode, SPLIT_MODES, 'equal'), JSON.stringify(asArray(row.splits)),
                    tsOrNow(row.created_at), tsOrNow(row.updated_at)]
            );
            bump(imported, 'expenses');
        }

        // 18. expense_settlements (both members must exist in the current circle)
        for (const row of asArray(data.expense_settlements)) {
            const amount = numberOrNull(row?.amount);
            if (amount === null || !row?.date
                || typeof row?.from_member !== 'string' || !circleMemberIds.has(row.from_member)
                || typeof row?.to_member !== 'string' || !circleMemberIds.has(row.to_member)) {
                bump(skipped, 'expense_settlements');
                continue;
            }
            await insert('expense_settlements',
                ['circle_id', 'from_member', 'to_member', 'amount', 'date', 'note', 'created_at'],
                [circleId, row.from_member, row.to_member, amount, row.date, textOrNull(row.note), tsOrNow(row.created_at)]
            );
            bump(imported, 'expense_settlements');
        }

        // 19. aid_records
        for (const row of asArray(data.aid_records)) {
            const amount = numberOrNull(row?.amount);
            if (amount === null) {
                bump(skipped, 'aid_records');
                continue;
            }
            await insert('aid_records',
                ['circle_id', 'type', 'label', 'amount', 'period_start', 'period_end', 'notes', 'created_at', 'updated_at'],
                [circleId, oneOf(row.type, AID_TYPES, 'other'), textOrNull(row.label), amount,
                    row.period_start ?? null, row.period_end ?? null, textOrNull(row.notes),
                    tsOrNow(row.created_at), tsOrNow(row.updated_at)]
            );
            bump(imported, 'aid_records');
        }

        await client.query('COMMIT');
        await broadcastToCircle(circleId, { type: 'update', entity: 'circle', action: 'synced' });
        res.json({ success: true, data: { imported, skipped } });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Import error:', error);
        res.status(500).json({ success: false, error: 'Import failed. No data was modified.' });
    } finally {
        client.release();
    }
});

export default router;
