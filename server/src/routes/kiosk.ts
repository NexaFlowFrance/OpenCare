import { Router, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { query, getClient } from '../db';
import { authMiddleware } from '../middleware/auth';
import { circleMiddleware, requireContentWriter, JOURNAL_WRITER_ROLES, CircleRequest } from '../middleware/circle';
import { kioskOrMember, allowDeviceOr, requireDevice, KioskRequest, KioskDeviceKind } from '../middleware/kioskDevice';
import { broadcastToCircle } from '../lib/broadcaster';
import { createNotification } from '../lib/notifications';
import { applyIntakeStatus, fetchIntakeForUpdate, IntakeSource } from '../lib/intakes';
import { loadTodaySnapshot } from '../lib/todaySnapshot';
import { loadCarePlan, filledSections } from '../lib/carePlan';
import { loadRules, createHelpRequest, resolveTargets } from '../lib/escalation';
import { fetchImmichRandomPhoto } from '../services/integrations/immich';
import { checkIn, checkOut, addVisitNote, VISITOR_TYPES, VisitorType } from '../lib/visits';
import { assertSafeIntegrationUrl, UnsafeUrlError } from '../utils/urlGuard';

// Kiosk routes: the wall tablet at the care recipient's home, and the same
// screen on the recipient's phone. Two ways in:
//  - an appaired patient device (X-Kiosk-Token): no caregiver session at all,
//    only the patient screens are reachable;
//  - a circle member session (legacy, and for caregivers who open /kiosk).
// Pairing, PIN and device management need a member session (admin or family).
// Mounted on /api/kiosk by app.ts.
const router = Router();

type KioskStatusKind = 'ok' | 'help' | 'hydration';

// Server-side strings: the kiosk writes journal entries and notifications on
// behalf of the care recipient, so the wording is resolved here (per user or
// device language, FR default like the rest of the app).
const STRINGS = {
    fr: {
        okContent: 'Tout va bien (signal envoyé depuis le kiosk)',
        helpContent: "J'ai besoin d'aide (signal envoyé depuis le kiosk)",
        hydrationContent: "A bu de l'eau (signalé depuis le kiosk)",
        helpTitle: (name: string) => `${name} demande de l'aide`,
        helpMessage: (name: string) => `${name} a appuyé sur le bouton d'aide du kiosk. Pensez à prendre des nouvelles tout de suite.`,
    },
    en: {
        okContent: 'All is well (signal sent from the kiosk)',
        helpContent: 'I need help (signal sent from the kiosk)',
        hydrationContent: 'Drank water (logged from the kiosk)',
        helpTitle: (name: string) => `${name} is asking for help`,
        helpMessage: (name: string) => `${name} pressed the help button on the kiosk. Please check in right away.`,
    },
} as const;

const pickLang = (language: unknown): keyof typeof STRINGS =>
    String(language || '').toLowerCase().startsWith('en') ? 'en' : 'fr';

// Journal entry type written for each kiosk button.
const KIND_TO_TYPE: Record<KioskStatusKind, string> = { ok: 'mood', help: 'incident', hydration: 'note' };

const PIN_SETTINGS_KEY = 'kiosk_pin_hash';
const PAIRING_TTL_MINUTES = 15;
// Codes lisibles sur une tablette : pas de 0/O, 1/I pour eviter les confusions.
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PIN_RE = /^\d{4,8}$/;

const newPairingCode = (): string =>
    Array.from(crypto.randomBytes(6), (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join('');

/** Langue de la personne devant l'ecran : reglage de l'appareil, sinon compte de l'aidant. */
async function screenLanguage(req: KioskRequest): Promise<keyof typeof STRINGS> {
    if (req.kioskDevice) return pickLang(req.kioskDevice.settings?.language);
    const result = await query('SELECT language FROM users WHERE id = $1', [req.userId]);
    return pickLang(result.rows[0]?.language);
}

async function getPinHash(circleId: string): Promise<string | null> {
    const result = await query(`SELECT settings->>'${PIN_SETTINGS_KEY}' AS hash FROM care_circles WHERE id = $1`, [circleId]);
    return (result.rows[0]?.hash as string | null) ?? null;
}

const publicDevice = (d: { id: string; name: string; kind: string; settings?: unknown }) => ({
    id: d.id, name: d.name, kind: d.kind, settings: d.settings ?? {},
});

// ============================================================
// Appairage (public, code a usage unique) et ecrans patient
// ============================================================

// POST /api/kiosk/pair : la tablette ou le telephone echange le code d'appairage
// contre son token d'appareil. Public, limite en debit dans app.ts.
router.post('/pair', async (req, res: Response) => {
    const client = await getClient();
    try {
        const raw = typeof req.body?.code === 'string' ? req.body.code : '';
        const code = raw.replace(/[\s-]/g, '').toUpperCase();
        if (!/^[A-Z0-9]{6,8}$/.test(code)) {
            return res.status(400).json({ success: false, error: 'PAIRING_CODE_INVALID' });
        }

        await client.query('BEGIN');
        const pairing = await client.query(
            `SELECT id, circle_id, kind, name, created_by FROM kiosk_pairings
             WHERE code = $1 AND consumed_at IS NULL AND expires_at > NOW()
             FOR UPDATE`,
            [code]
        );
        const row = pairing.rows[0] as { id: string; circle_id: string; kind: KioskDeviceKind; name: string; created_by: string | null } | undefined;
        if (!row) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'PAIRING_CODE_INVALID' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const device = await client.query(
            `INSERT INTO kiosk_devices (circle_id, token, name, kind, created_by, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING id, name, kind, settings`,
            [row.circle_id, token, row.name, row.kind, row.created_by]
        );
        await client.query('UPDATE kiosk_pairings SET consumed_at = NOW() WHERE id = $1', [row.id]);
        const recipient = await client.query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [row.circle_id]);
        await client.query('COMMIT');

        await broadcastToCircle(row.circle_id, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({
            success: true,
            data: {
                token,
                circle_id: row.circle_id,
                device: publicDevice(device.rows[0]),
                recipient_first_name: recipient.rows[0]?.first_name ?? null,
            },
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Kiosk pair error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// GET /api/kiosk/today : everything the patient screen shows, in one call.
router.get('/today', kioskOrMember(), async (req: KioskRequest, res: Response) => {
    try {
        const circleId = req.circleId!;
        // The same snapshot feeds the "Ask me" companion (lib/todaySnapshot).
        const [snapshot, pinHash] = await Promise.all([loadTodaySnapshot(circleId), getPinHash(circleId)]);
        res.json({
            success: true,
            data: {
                ...snapshot,
                // Caregiver settings and leaving the screen are protected by a PIN when one is set.
                pin_required: Boolean(pinHash),
                device: req.kioskDevice ? publicDevice(req.kioskDevice) : null,
            },
        });
    } catch (error) {
        console.error('Kiosk today error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/kiosk/status : the big buttons of the kiosk.
// 'ok'        -> journal entry of type 'mood' authored by the care recipient.
// 'help'      -> journal entry of type 'incident' + urgent notification to every
//                member of the circle (in-app + web push via createNotification).
// 'hydration' -> journal entry of type 'note' (heat episode hydration check-in),
//                no notification.
// A patient device is accepted; a member session needs a journal-writer role.
router.post('/status', kioskOrMember(), allowDeviceOr(...JOURNAL_WRITER_ROLES), async (req: KioskRequest, res: Response) => {
    try {
        const kind = req.body?.kind as KioskStatusKind;
        if (kind !== 'ok' && kind !== 'help' && kind !== 'hydration') {
            return res.status(400).json({ success: false, error: 'Invalid kind' });
        }

        const [recipientResult, sessionLang] = await Promise.all([
            query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [req.circleId]),
            screenLanguage(req),
        ]);

        const firstName: string = recipientResult.rows[0]?.first_name?.trim() || 'Kiosk';
        const sessionStrings = STRINGS[sessionLang];

        const content = kind === 'help'
            ? sessionStrings.helpContent
            : kind === 'hydration'
                ? sessionStrings.hydrationContent
                : sessionStrings.okContent;

        const entryResult = await query(
            `INSERT INTO journal_entries (circle_id, author_name, type, content, data)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [
                req.circleId,
                firstName,
                KIND_TO_TYPE[kind],
                content,
                JSON.stringify({ source: req.kioskDevice?.kind ?? 'kiosk', kind, device_id: req.kioskDevice?.id ?? null }),
            ]
        );
        const entry = entryResult.rows[0];

        // "Tout va bien" is a sign of life: it feeds the passive watch (presence
        // rules) exactly like a Home Assistant sensor would.
        if (kind === 'ok') {
            await query(
                `INSERT INTO presence_signals (circle_id, source, kind, payload) VALUES ($1, 'kiosk', 'other', $2)`,
                [req.circleId, JSON.stringify({ kind: 'ok', device_id: req.kioskDevice?.id ?? null })]
            );
        }

        if (kind === 'help') {
            // Escalation rules (lib/escalation): the primary caregivers first
            // (admins by default), the backup caregivers later if nobody takes
            // charge. Without rules, every member is notified, as before.
            const rules = await loadRules(req.circleId!);
            await createHelpRequest(req.circleId!, entry.id, req.kioskDevice?.kind ?? 'kiosk');
            const recipients: Array<{ user_id: string; language: string | null }> = rules.enabled
                ? await resolveTargets(req.circleId!, rules.primary_member_ids, ['admin'])
                : (await query(
                    `SELECT m.user_id, u.language FROM circle_members m JOIN users u ON u.id = m.user_id WHERE m.circle_id = $1`,
                    [req.circleId]
                )).rows;
            await Promise.all(recipients.map((member) => {
                const strings = STRINGS[pickLang(member.language)];
                return createNotification({
                    userId: member.user_id,
                    circleId: req.circleId,
                    title: strings.helpTitle(firstName),
                    message: strings.helpMessage(firstName),
                    type: 'kiosk_help',
                    relatedId: entry.id,
                    url: '/',
                    tag: 'kiosk_help',
                });
            }));
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'help_requests', action: 'created' });
        }

        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'created' });

        res.json({ success: true, data: { ...entry, photos: [] } });
    } catch (error) {
        console.error('Kiosk status error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/kiosk/intakes/confirm : "I've taken all of these" on the kiosk (or
// the patient phone). Body { intake_ids: string[], source?: 'kiosk' | 'phone' }.
// Every pending intake of the list is marked taken, attributed to the care
// recipient by name, with the confirmation source kept for the audit trail.
router.post('/intakes/confirm', kioskOrMember(), allowDeviceOr(...JOURNAL_WRITER_ROLES), async (req: KioskRequest, res: Response) => {
    const ids = Array.isArray(req.body?.intake_ids)
        ? (req.body.intake_ids as unknown[]).filter((id): id is string => typeof id === 'string').slice(0, 50)
        : [];
    if (ids.length === 0) {
        return res.status(400).json({ success: false, error: 'intake_ids required' });
    }
    const source: IntakeSource = req.kioskDevice
        ? req.kioskDevice.kind
        : (req.body?.source === 'phone' ? 'phone' : 'kiosk');

    const client = await getClient();
    try {
        await client.query('BEGIN');
        const recipientResult = await client.query('SELECT first_name FROM care_recipients WHERE circle_id = $1', [req.circleId]);
        let authorName = (recipientResult.rows[0]?.first_name as string | undefined) || 'Kiosk';
        // A visiting professional (checked in on the screen) confirms in their own name.
        if (typeof req.body?.visit_id === 'string') {
            const visit = await client.query(
                `SELECT visitor_name FROM visits WHERE id = $1 AND circle_id = $2 AND checked_out_at IS NULL`,
                [req.body.visit_id, req.circleId]
            );
            if (visit.rows[0]?.visitor_name) authorName = visit.rows[0].visitor_name as string;
        }

        const confirmed: unknown[] = [];
        for (const id of ids) {
            const intake = await fetchIntakeForUpdate(client, id, req.circleId!);
            if (!intake) continue;
            const current = await client.query('SELECT status FROM medication_intakes WHERE id = $1', [id]);
            if (current.rows[0]?.status === 'taken') continue;
            confirmed.push(await applyIntakeStatus(client, intake, 'taken', { userId: req.userId, name: authorName }, source));
        }
        await client.query('COMMIT');

        if (confirmed.length > 0) {
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'intakes', action: 'updated' });
            await broadcastToCircle(req.circleId!, { type: 'update', entity: 'journal', action: 'updated' });
        }
        res.json({ success: true, data: { confirmed: confirmed.length } });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Kiosk confirm intakes error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// ============================================================
// Visiteurs : "quelqu'un est la" depuis l'ecran patient
// ============================================================

// POST /api/kiosk/visits/check-in { visitor_type, visitor_name, member_id? }
router.post('/visits/check-in', kioskOrMember(), allowDeviceOr(...JOURNAL_WRITER_ROLES), async (req: KioskRequest, res: Response) => {
    try {
        const visitorType = req.body?.visitor_type as VisitorType;
        const visitorName = typeof req.body?.visitor_name === 'string' ? req.body.visitor_name.trim().slice(0, 100) : '';
        if (!VISITOR_TYPES.includes(visitorType) || !visitorName) {
            return res.status(400).json({ success: false, error: 'visitor_type and visitor_name required' });
        }
        let memberId: string | null = null;
        if (typeof req.body?.member_id === 'string') {
            const member = await query('SELECT id FROM circle_members WHERE id = $1 AND circle_id = $2', [req.body.member_id, req.circleId]);
            memberId = member.rows[0]?.id ?? null;
        }
        const visit = await checkIn({
            circleId: req.circleId!,
            visitorType,
            visitorName,
            memberId,
            deviceId: req.kioskDevice?.id ?? null,
            lang: await screenLanguage(req),
        });
        res.json({ success: true, data: visit });
    } catch (error) {
        console.error('Kiosk visit check-in error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/kiosk/visits/:id/check-out
router.post('/visits/:id/check-out', kioskOrMember(), allowDeviceOr(...JOURNAL_WRITER_ROLES), async (req: KioskRequest, res: Response) => {
    try {
        const visit = await checkOut(req.circleId!, req.params.id, await screenLanguage(req));
        if (!visit) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, data: visit });
    } catch (error) {
        console.error('Kiosk visit check-out error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/kiosk/visits/:id/note { content } : note de passage d'un professionnel
router.post('/visits/:id/note', kioskOrMember(), allowDeviceOr(...JOURNAL_WRITER_ROLES), async (req: KioskRequest, res: Response) => {
    try {
        const content = typeof req.body?.content === 'string' ? req.body.content.trim().slice(0, 2000) : '';
        if (!content) return res.status(400).json({ success: false, error: 'content required' });
        const visit = await addVisitNote(req.circleId!, req.params.id, content);
        if (!visit) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, data: visit });
    } catch (error) {
        console.error('Kiosk visit note error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/kiosk/photo : a random family photo from the circle's Immich (the
// API key never reaches the device). Same proxy as /api/integrations/immich/photo,
// exposed here so a patient device can use it without a caregiver session.
router.get('/photo', kioskOrMember(), async (req: KioskRequest, res: Response) => {
    try {
        const result = await query(
            `SELECT base_url, encrypted_credentials FROM integrations WHERE circle_id = $1 AND type = 'immich'`,
            [req.circleId]
        );
        const integ = result.rows[0] as { base_url: string; encrypted_credentials: string | null } | undefined;
        if (!integ || !integ.encrypted_credentials) {
            return res.status(404).json({ success: false, error: 'IMMICH_NOT_CONFIGURED' });
        }
        await assertSafeIntegrationUrl(integ.base_url);
        const photo = await fetchImmichRandomPhoto(integ.base_url, integ.encrypted_credentials);
        res.set('Content-Type', photo.contentType);
        res.set('Cache-Control', 'no-store');
        res.send(photo.buffer);
    } catch (e) {
        if (e instanceof UnsafeUrlError) {
            return res.status(400).json({ success: false, error: 'URL_BLOCKED' });
        }
        res.status(502).json({ success: false, error: 'IMMICH_UNAVAILABLE' });
    }
});

// POST /api/kiosk/pin/verify : the caregiver PIN that protects settings and
// leaving the screen. { pin } -> { ok, configured }. Rate limited in app.ts.
router.post('/pin/verify', kioskOrMember(), async (req: KioskRequest, res: Response) => {
    try {
        const hash = await getPinHash(req.circleId!);
        if (!hash) {
            return res.json({ success: true, data: { ok: true, configured: false } });
        }
        const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
        const ok = PIN_RE.test(pin) && (await bcrypt.compare(pin, hash));
        res.json({ success: true, data: { ok, configured: true } });
    } catch (error) {
        console.error('Kiosk pin verify error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// The device itself (token only)
// ============================================================

router.get('/device', kioskOrMember(), requireDevice, (req: KioskRequest, res: Response) => {
    res.json({ success: true, data: publicDevice(req.kioskDevice!) });
});

// PUT /api/kiosk/device/settings : display settings kept server-side so a
// device keeps them after a reinstall. Allowlisted keys only.
router.put('/device/settings', kioskOrMember(), requireDevice, async (req: KioskRequest, res: Response) => {
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if ('location' in body) {
            const loc = body.location as { name?: unknown; lat?: unknown; lon?: unknown } | null;
            patch.location = loc && typeof loc.name === 'string' && typeof loc.lat === 'number' && typeof loc.lon === 'number'
                ? { name: loc.name.slice(0, 100), lat: loc.lat, lon: loc.lon }
                : null;
        }
        if ('photoBackground' in body) patch.photoBackground = body.photoBackground === true;
        if ('language' in body) patch.language = body.language === 'en' ? 'en' : 'fr';
        if ('fontScale' in body) {
            const scale = Number(body.fontScale);
            patch.fontScale = Number.isFinite(scale) ? Math.min(1.5, Math.max(0.9, scale)) : 1;
        }
        const result = await query(
            `UPDATE kiosk_devices SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb
             WHERE id = $1 AND revoked_at IS NULL
             RETURNING id, name, kind, settings`,
            [req.kioskDevice!.id, JSON.stringify(patch)]
        );
        res.json({ success: true, data: publicDevice(result.rows[0]) });
    } catch (error) {
        console.error('Kiosk device settings error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/kiosk/device/unpair : the device forgets itself (after the PIN).
router.post('/device/unpair', kioskOrMember(), requireDevice, async (req: KioskRequest, res: Response) => {
    try {
        await query('UPDATE kiosk_devices SET revoked_at = NOW() WHERE id = $1', [req.kioskDevice!.id]);
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: {} });
    } catch (error) {
        console.error('Kiosk unpair error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ============================================================
// Management by the circle (member session, admin or family)
// ============================================================

const manage = [authMiddleware, circleMiddleware, requireContentWriter];

// GET /api/kiosk/devices : paired devices and whether a PIN is set.
router.get('/devices', ...manage, async (req: CircleRequest, res: Response) => {
    try {
        const [devices, pinHash] = await Promise.all([
            query(
                `SELECT id, name, kind, last_seen_at, created_at
                 FROM kiosk_devices WHERE circle_id = $1 AND revoked_at IS NULL
                 ORDER BY created_at`,
                [req.circleId]
            ),
            getPinHash(req.circleId!),
        ]);
        res.json({ success: true, data: { devices: devices.rows, pin_configured: Boolean(pinHash) } });
    } catch (error) {
        console.error('Kiosk devices error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST /api/kiosk/devices/pairing : a one-time code (15 min) to type on the device.
router.post('/devices/pairing', ...manage, async (req: CircleRequest, res: Response) => {
    try {
        const kind: KioskDeviceKind = req.body?.kind === 'phone' ? 'phone' : 'kiosk';
        const rawName = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
        const name = rawName || (kind === 'phone' ? 'Telephone' : 'Tablette');

        // Retry on the (unlikely) code collision.
        let code = newPairingCode();
        for (let attempt = 0; attempt < 3; attempt++) {
            const exists = await query('SELECT 1 FROM kiosk_pairings WHERE code = $1', [code]);
            if (exists.rows.length === 0) break;
            code = newPairingCode();
        }
        const result = await query(
            `INSERT INTO kiosk_pairings (circle_id, code, kind, name, created_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' minutes')::interval)
             RETURNING code, kind, name, expires_at`,
            [req.circleId, code, kind, name, req.userId, String(PAIRING_TTL_MINUTES)]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Kiosk pairing error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// DELETE /api/kiosk/devices/:id : revoke a device (its token stops working at once).
router.delete('/devices/:id', ...manage, async (req: CircleRequest, res: Response) => {
    try {
        const result = await query(
            `UPDATE kiosk_devices SET revoked_at = NOW()
             WHERE id = $1 AND circle_id = $2 AND revoked_at IS NULL
             RETURNING id`,
            [req.params.id, req.circleId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        res.json({ success: true, data: {} });
    } catch (error) {
        console.error('Kiosk revoke error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PUT /api/kiosk/pin : set or replace the caregiver PIN (4 to 8 digits), stored
// hashed in the circle settings. DELETE removes it.
router.put('/pin', ...manage, async (req: CircleRequest, res: Response) => {
    try {
        const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
        if (!PIN_RE.test(pin)) {
            return res.status(400).json({ success: false, error: 'PIN_INVALID' });
        }
        const hash = await bcrypt.hash(pin, 10);
        await query(
            `UPDATE care_circles
             SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{${PIN_SETTINGS_KEY}}', to_jsonb($2::text))
             WHERE id = $1`,
            [req.circleId, hash]
        );
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: { pin_configured: true } });
    } catch (error) {
        console.error('Kiosk pin set error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.delete('/pin', ...manage, async (req: CircleRequest, res: Response) => {
    try {
        await query(
            `UPDATE care_circles SET settings = COALESCE(settings, '{}'::jsonb) - '${PIN_SETTINGS_KEY}' WHERE id = $1`,
            [req.circleId]
        );
        await broadcastToCircle(req.circleId!, { type: 'update', entity: 'circle', action: 'updated' });
        res.json({ success: true, data: { pin_configured: false } });
    } catch (error) {
        console.error('Kiosk pin clear error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/kiosk/care-plan : the family's care instructions (non-empty
// sections only), shown to a professional visitor during a visit.
router.get('/care-plan', kioskOrMember(), async (req: KioskRequest, res: Response) => {
    try {
        const plan = await loadCarePlan(req.circleId!);
        res.json({ success: true, data: { sections: filledSections(plan.sections), updated_at: plan.updated_at } });
    } catch (error) {
        console.error('Kiosk care plan error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
