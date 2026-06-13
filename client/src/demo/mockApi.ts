// Backend simulé dans le navigateur pour la démo statique (GitHub Pages,
// VITE_DEMO=1). Pas de réseau, pas de persistance : le store est recréé à
// chaque chargement de page. Les réponses reproduisent la forme exacte de
// l'API réelle ({ success, data }) telle que renvoyée par server/src/routes.
//
// Le cercle actif est résolu depuis localStorage (la clé qu'utilise
// ApiClient.setCircleId), faute d'en-tête X-Circle-Id dans le mock.
import { createSeed, type CircleData, type DemoStore, type Json } from './seed';

const store: DemoStore = createSeed();

const ok = <T,>(data: T) => ({ success: true, data });
const uid = () =>
    (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'id-' + Math.random().toString(36).slice(2));

const pad2 = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** Horodatage naïf local "YYYY-MM-DDTHH:mm:ss", comme les TIMESTAMP du serveur. */
const toLocalISO = (d: Date) =>
    `${isoDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const naiveNow = () => toLocalISO(new Date());

const stripQuery = (ep: string) => {
    const i = ep.indexOf('?');
    return i >= 0 ? ep.slice(0, i) : ep;
};
const queryParams = (ep: string): Record<string, string> => {
    const i = ep.indexOf('?');
    if (i < 0) return {};
    return Object.fromEntries(new URLSearchParams(ep.slice(i + 1)));
};

const num = (v: unknown): number => {
    const n = typeof v === 'string' ? parseFloat(v) : (v as number);
    return Number.isFinite(n) ? (n as number) : 0;
};

const CIRCLE_KEY = 'opencare:circle-id';

/** Le cercle actif (sélecteur multi-proches), par défaut le premier (Jeanne). */
function activeCircle(): CircleData {
    const id = typeof localStorage !== 'undefined' ? localStorage.getItem(CIRCLE_KEY) : null;
    return store.circles.find((c) => c.id === id) ?? store.circles[0];
}

const circleById = (id: string): CircleData | undefined => store.circles.find((c) => c.id === id);

function removeFrom(arr: Json[], id: string): void {
    const idx = arr.findIndex((x) => x.id === id);
    if (idx >= 0) arr.splice(idx, 1);
}
function updateIn(arr: Json[], id: string, patch: Json): Json | null {
    const idx = arr.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    arr[idx] = { ...arr[idx], ...patch };
    return arr[idx];
}

const myMemberIn = (c: CircleData): Json | undefined =>
    c.members.find((m) => m.user_id === store.user.id);

// ── Cercles ──────────────────────────────────────────────────────────────────

const circleSummary = (c: CircleData): Json => ({
    id: c.id,
    name: c.name,
    currency: c.currency,
    settings: c.settings,
    created_at: c.created_at,
    role: c.role,
    color: c.color,
    recipient_id: c.recipient ? c.recipient.id : null,
    recipient_first_name: c.recipient ? c.recipient.first_name : null,
    recipient_last_name: c.recipient ? c.recipient.last_name : null,
    recipient_photo_url: c.recipient ? c.recipient.photo_url : null,
    recipient_birth_date: c.recipient ? c.recipient.birth_date : null,
    member_count: c.members.length,
});

const circleRow = (c: CircleData): Json => ({
    id: c.id, name: c.name, currency: c.currency, settings: c.settings, created_at: c.created_at,
});

function makeCircle(name: string, recipient: Json): CircleData {
    const id = uid();
    return {
        id, name, currency: 'EUR', settings: {}, created_at: naiveNow(), role: 'admin', color: '#2563EB',
        recipient: { id: uid(), circle_id: id, photo_url: null, last_name: null, birth_date: null, ...recipient },
        members: [{
            id: uid(), circle_id: id, user_id: store.user.id, role: 'admin', color: '#2563EB',
            created_at: naiveNow(), name: store.user.name, email: store.user.email, avatar_url: null,
        }],
        invites: [], caregiverLinks: [], journal: [], vitals: [], medications: [], intakeOverrides: {},
        prescriptions: [], events: [], tasks: [], shopping: [], messages: [], documents: [], contacts: [],
        expenses: [], settlements: [], aids: [], notes: [],
        story: { id: uid(), circle_id: id, sections: [], updated_by: null, updated_at: naiveNow(), created_at: naiveNow() },
        emergencySheet: { id: uid(), circle_id: id, public_token: 'demo-urgence-' + id.slice(0, 8), enabled: false, extra_notes: null, updated_at: naiveNow(), created_at: naiveNow() },
        digests: [], presenceSignals: [], presenceRule: null, presenceWebhookUrl: null,
    };
}

// ── Calendrier : expansion NAÏVE des récurrences (FREQ=DAILY / WEEKLY+BYDAY) ─

const DAY_CODES: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function expandEvents(c: CircleData, from: Date, to: Date): Json[] {
    const membersById = new Map(c.members.map((m) => [m.id as string, m]));
    const out: Json[] = [];

    const push = (ev: Json, start: Date, end: Date | null, recurring: boolean) => {
        const memberIds: string[] = Array.isArray(ev.member_ids) ? ev.member_ids : [];
        out.push({
            ...ev,
            member_ids: memberIds,
            start_time: toLocalISO(start),
            end_time: end ? toLocalISO(end) : null,
            occurrence_date: isoDate(start),
            is_recurring: recurring,
            members_data: memberIds
                .map((id) => membersById.get(id))
                .filter(Boolean)
                .map((m) => ({ id: m!.id, name: m!.name, color: m!.color, role: m!.role })),
        });
    };

    for (const ev of c.events) {
        const start = new Date(ev.start_time);
        const durMs = ev.end_time ? new Date(ev.end_time).getTime() - start.getTime() : null;

        if (!ev.rrule) {
            const effectiveEnd = durMs !== null ? new Date(start.getTime() + durMs) : start;
            if (effectiveEnd.getTime() >= from.getTime() && start.getTime() <= to.getTime()) {
                push(ev, start, durMs !== null ? new Date(start.getTime() + durMs) : null, false);
            }
            continue;
        }

        const parts: Record<string, string> = {};
        for (const p of String(ev.rrule).split(';')) {
            const eq = p.indexOf('=');
            if (eq > 0) parts[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).toUpperCase();
        }
        const freq = parts.FREQ;
        const byDays = parts.BYDAY
            ? parts.BYDAY.split(',').filter((code) => code in DAY_CODES).map((code) => DAY_CODES[code])
            : null;

        let guard = 0;
        for (let d = startOfDay(from); d.getTime() <= to.getTime() && guard < 400; d.setDate(d.getDate() + 1)) {
            guard++;
            if (d.getTime() < startOfDay(start).getTime()) continue;
            let matches = false;
            if (freq === 'DAILY') matches = true;
            else if (freq === 'WEEKLY') matches = (byDays ?? [start.getDay()]).includes(d.getDay());
            if (!matches) continue;
            const occStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), start.getHours(), start.getMinutes(), 0);
            push(ev, occStart, durMs !== null ? new Date(occStart.getTime() + durMs) : null, true);
        }
    }

    out.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
    return out;
}

const parseDayParam = (value: string, endOfDay: boolean): Date => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [yy, mm, dd] = value.split('-').map(Number);
        return endOfDay ? new Date(yy, mm - 1, dd, 23, 59, 59) : new Date(yy, mm - 1, dd, 0, 0, 0);
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date() : d;
};

// ── Médicaments : génération paresseuse des prises depuis les horaires ───────

const isoDow = (d: Date) => ((d.getDay() + 6) % 7) + 1;

function buildIntake(c: CircleData, med: Json, sch: Json, dateStr: string): Json {
    const dueAt = `${dateStr}T${sch.time_of_day}:00`;
    const id = `in_${med.id}_${sch.id}_${dateStr}`;
    const override = (c.intakeOverrides as Json)[id];
    let status = 'pending';
    let confirmedAt: string | null = null;
    if (override) {
        status = override.status;
        confirmedAt = override.confirmed_at ?? null;
    } else {
        const due = new Date(dueAt);
        // Sans surcharge, une prise passée de plus de 4h est considérée faite
        // (la démo affiche une bonne observance hors oublis volontairement semés).
        if (due.getTime() < Date.now() - 4 * 3600 * 1000) {
            status = 'taken';
            confirmedAt = toLocalISO(new Date(due.getTime() + 10 * 60000));
        }
    }
    return {
        id, circle_id: c.id, medication_id: med.id, schedule_id: sch.id, due_at: dueAt, status,
        confirmed_by_user: null, confirmed_by_link: null, confirmed_at: confirmedAt,
        journal_entry_id: override ? override.journal_entry_id ?? null : null,
        medication_name: med.name, medication_dosage: med.dosage ?? null,
        dosage: med.dosage ?? null, form: med.form ?? null, schedule_label: sch.label ?? null,
    };
}

function intakesForRange(c: CircleData, fromStr: string, toStr: string, maxDays = 14): Json[] {
    const out: Json[] = [];
    const from = new Date(`${fromStr}T00:00:00`);
    const to = new Date(`${toStr}T00:00:00`);
    let days = 0;
    for (let d = new Date(from); d.getTime() <= to.getTime() && days < maxDays; d.setDate(d.getDate() + 1)) {
        days++;
        const dateStr = isoDate(d);
        const dow = isoDow(d);
        for (const med of c.medications) {
            if (med.active === false) continue;
            if (med.start_date && dateStr < med.start_date) continue;
            if (med.end_date && dateStr > med.end_date) continue;
            for (const sch of (med.schedules as Json[]) || []) {
                if (Array.isArray(sch.days_of_week) && !sch.days_of_week.includes(dow)) continue;
                out.push(buildIntake(c, med, sch, dateStr));
            }
        }
    }
    out.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
    return out;
}

function setIntakeStatus(c: CircleData, intakeId: string, status: string): Json | null {
    const [, medId, schId, dateStr] = intakeId.split('_');
    const med = c.medications.find((m) => m.id === medId);
    const sch = med ? ((med.schedules as Json[]) || []).find((s) => s.id === schId) : undefined;
    if (!med || !sch || !dateStr) return null;

    const previous = (c.intakeOverrides as Json)[intakeId];
    if (previous && previous.journal_entry_id) {
        removeFrom(c.journal, previous.journal_entry_id);
    }

    if (status === 'pending') {
        (c.intakeOverrides as Json)[intakeId] = { status: 'pending', confirmed_at: null, journal_entry_id: null };
        return buildIntake(c, med, sch, dateStr);
    }

    const entryId = uid();
    c.journal.unshift({
        id: entryId, circle_id: c.id, author_user_id: store.user.id, caregiver_link_id: null,
        author_name: store.user.name, type: 'medication',
        content: med.dosage ? `${med.name} ${med.dosage}` : med.name,
        data: { medication_id: med.id, intake_id: intakeId, status },
        occurred_at: naiveNow(), created_at: naiveNow(), photos: [],
    });
    (c.intakeOverrides as Json)[intakeId] = { status, confirmed_at: naiveNow(), journal_entry_id: entryId };
    return buildIntake(c, med, sch, dateStr);
}

// ── Frais partagés : soldes façon Tricount ───────────────────────────────────

const toCents = (n: number) => Math.round(n * 100);
const fromCents = (cents: number) => Math.round(cents) / 100;

function computeBalances(c: CircleData): Json {
    const members = c.members.filter((m) => m.role === 'admin' || m.role === 'family');
    const paid = new Map<string, number>();
    const owed = new Map<string, number>();
    const sent = new Map<string, number>();
    const received = new Map<string, number>();
    const add = (map: Map<string, number>, key: string, cents: number) =>
        map.set(key, (map.get(key) ?? 0) + cents);

    for (const e of c.expenses) {
        add(paid, e.paid_by, toCents(num(e.amount)));
        for (const s of (e.splits as Json[]) || []) add(owed, s.member_id, toCents(num(s.share)));
    }
    for (const s of c.settlements) {
        add(sent, s.from_member, toCents(num(s.amount)));
        add(received, s.to_member, toCents(num(s.amount)));
    }

    const rows = members.map((m) => {
        const id = m.id as string;
        const net = (paid.get(id) ?? 0) - (owed.get(id) ?? 0) + (sent.get(id) ?? 0) - (received.get(id) ?? 0);
        return {
            member_id: id, name: m.name, role: m.role, color: m.color,
            total_paid: fromCents(paid.get(id) ?? 0),
            total_owed: fromCents(owed.get(id) ?? 0),
            settlements_sent: fromCents(sent.get(id) ?? 0),
            settlements_received: fromCents(received.get(id) ?? 0),
            balance: fromCents(net),
            _net: net,
        };
    });

    // Plan de remboursement glouton : le plus gros débiteur rembourse le plus gros créancier.
    const debtors = rows.filter((b) => b._net < 0).map((b) => ({ member_id: b.member_id, cents: -b._net })).sort((a, b) => b.cents - a.cents);
    const creditors = rows.filter((b) => b._net > 0).map((b) => ({ member_id: b.member_id, cents: b._net })).sort((a, b) => b.cents - a.cents);
    const suggested: Json[] = [];
    let d = 0;
    let cIdx = 0;
    while (d < debtors.length && cIdx < creditors.length) {
        const transfer = Math.min(debtors[d].cents, creditors[cIdx].cents);
        if (transfer > 0) {
            suggested.push({ from_member: debtors[d].member_id, to_member: creditors[cIdx].member_id, amount: fromCents(transfer) });
        }
        debtors[d].cents -= transfer;
        creditors[cIdx].cents -= transfer;
        if (debtors[d].cents === 0) d++;
        if (creditors[cIdx].cents === 0) cIdx++;
    }

    return {
        balances: rows.map(({ _net, ...rest }) => rest),
        suggested_settlements: suggested,
    };
}

function equalSplits(amount: number, memberIds: string[]): Json[] {
    const totalCents = toCents(amount);
    const base = Math.floor(totalCents / memberIds.length);
    const remainder = totalCents - base * memberIds.length;
    return memberIds.map((member_id, index) => ({
        member_id,
        share: fromCents(base + (index < remainder ? 1 : 0)),
    }));
}

function expensesSummary(c: CircleData): Json {
    const year = new Date().getFullYear();
    const byCat = new Map<string, number>();
    for (const e of c.expenses) {
        if (parseInt(String(e.date).slice(0, 4), 10) !== year) continue;
        byCat.set(e.category, (byCat.get(e.category) ?? 0) + toCents(num(e.amount)));
    }
    const categories = Array.from(byCat.entries())
        .map(([category, cents]) => ({ category, total: fromCents(cents) }))
        .sort((a, b) => b.total - a.total);
    const totalAids = c.aids.reduce((acc, a) => {
        const ref = String(a.period_start || a.created_at || '');
        return parseInt(ref.slice(0, 4), 10) === year ? acc + toCents(num(a.amount)) : acc;
    }, 0);
    return {
        year,
        by_category: categories,
        total_expenses: fromCents(categories.reduce((acc, cat) => acc + toCents(cat.total), 0)),
        total_aids: fromCents(totalAids),
    };
}

// ── Équité de la charge ──────────────────────────────────────────────────────

function equityWindow(c: CircleData, start: Date, end: Date): Json[] {
    const inRange = (value: unknown) => {
        const t = new Date(String(value)).getTime();
        return t >= start.getTime() && t < end.getTime();
    };
    return c.members
        .filter((m) => ['admin', 'family', 'professional'].includes(m.role))
        .map((m) => ({
            member_id: m.id,
            user_id: m.user_id,
            role: m.role,
            color: m.color,
            name: m.name,
            visits: c.journal.filter((e) => e.type === 'visit' && e.author_user_id === m.user_id && inRange(e.occurred_at)).length,
            tasks: c.tasks.filter((t) => t.is_completed && t.completed_by === m.user_id && t.completed_at && inRange(t.completed_at)).length,
            events: c.events.filter((ev) => {
                const s = new Date(ev.start_time);
                return inRange(ev.start_time) && s.getTime() <= Date.now()
                    && Array.isArray(ev.member_ids) && ev.member_ids.includes(m.id);
            }).length,
        }));
}

function withTotals(rows: Json[]): Json {
    const totals = rows.reduce(
        (acc, r) => ({ visits: acc.visits + r.visits, tasks: acc.tasks + r.tasks, events: acc.events + r.events }),
        { visits: 0, tasks: 0, events: 0 }
    );
    const grandTotal = totals.visits + totals.tasks + totals.events;
    const members = rows.map((r) => {
        const total = r.visits + r.tasks + r.events;
        return { ...r, total, percent: grandTotal > 0 ? Math.round((total / grandTotal) * 100) : 0 };
    });
    return { members, totals: { ...totals, total: grandTotal } };
}

// ── Constantes, tâches, dashboard, kiosk ─────────────────────────────────────

function latestVitals(c: CircleData): Json[] {
    const byType = new Map<string, Json>();
    for (const v of c.vitals) {
        const current = byType.get(v.type);
        if (!current || String(v.measured_at) > String(current.measured_at)) byType.set(v.type, v);
    }
    return Array.from(byType.values());
}

function enrichTask(c: CircleData, task: Json): Json {
    const membersById = new Map(c.members.map((m) => [m.id as string, m]));
    const assignedTo: string[] = Array.isArray(task.assigned_to) ? task.assigned_to : [];
    return {
        ...task,
        assigned_to: assignedTo,
        assigned_to_members: assignedTo
            .map((id) => membersById.get(id))
            .filter(Boolean)
            .map((m) => ({ id: m!.id, color: m!.color, name: m!.name })),
    };
}

const sortTasks = (tasks: Json[]): Json[] =>
    [...tasks].sort((a, b) => {
        if (a.due_date && b.due_date) return String(a.due_date).localeCompare(String(b.due_date));
        if (a.due_date) return -1;
        if (b.due_date) return 1;
        return String(b.created_at).localeCompare(String(a.created_at));
    });

const journalDesc = (c: CircleData): Json[] =>
    [...c.journal].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));

function dashboard(c: CircleData): Json {
    const now = new Date();
    const dayStart = startOfDay(now);
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const today = isoDate(now);
    const pending = c.tasks.filter((t) => !t.is_completed);

    return {
        recipient: c.recipient ? { first_name: c.recipient.first_name, photo_url: c.recipient.photo_url } : null,
        today_events: expandEvents(c, dayStart, dayEnd),
        last_journal_entries: journalDesc(c).slice(0, 5).map((e) => ({
            id: e.id, author_name: e.author_name, type: e.type, content: e.content,
            occurred_at: e.occurred_at, created_at: e.created_at,
        })),
        pending_tasks: {
            count: pending.length,
            next: sortTasks(pending).slice(0, 5).map((t) => ({
                id: t.id, title: t.title, category: t.category, due_date: t.due_date,
                priority: t.priority, assigned_to: t.assigned_to,
            })),
        },
        medication_intakes_today: intakesForRange(c, today, today),
        latest_vitals: latestVitals(c).map((v) => ({
            type: v.type, value: v.value, value2: v.value2, unit: v.unit, measured_at: v.measured_at,
        })),
        unread_messages_count: 0,
    };
}

function kioskToday(c: CircleData): Json {
    const now = new Date();
    const dayStart = startOfDay(now);
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const membersById = new Map(c.members.map((m) => [m.id as string, m]));

    return {
        recipient: c.recipient ? { first_name: c.recipient.first_name, photo_url: c.recipient.photo_url } : null,
        events_today: expandEvents(c, dayStart, dayEnd).map((occ) => ({
            id: occ.id, title: occ.title, category: occ.category, location: occ.location,
            start_time: occ.start_time, end_time: occ.end_time,
            members: ((occ.member_ids as string[]) || [])
                .map((id) => membersById.get(id))
                .filter(Boolean)
                .map((m) => ({ id: m!.id, name: m!.name, avatar_url: m!.avatar_url })),
        })),
        intakes_today: intakesForRange(c, isoDate(now), isoDate(now)).map((i) => ({
            id: i.id, due_at: i.due_at, status: i.status, confirmed_at: i.confirmed_at,
            medication_name: i.medication_name, dosage: i.dosage, form: i.form,
        })),
        photos_enabled: false,
    };
}

// ── Préparation de consultation ──────────────────────────────────────────────

function consultation(c: CircleData, sinceParam?: string): Json {
    let since: Date;
    if (sinceParam && /^\d{4}-\d{2}-\d{2}$/.test(sinceParam)) {
        since = new Date(`${sinceParam}T00:00:00`);
    } else {
        since = new Date();
        since.setDate(since.getDate() - 90);
        since.setHours(0, 0, 0, 0);
    }
    const until = new Date();

    const highlights = journalDesc(c)
        .filter((e) => ['incident', 'mood', 'visit'].includes(e.type) && new Date(e.occurred_at).getTime() >= since.getTime())
        .slice(0, 40)
        .map((e) => ({ id: e.id, type: e.type, content: e.content, author_name: e.author_name, occurred_at: e.occurred_at }));

    const seriesByType = new Map<string, Json[]>();
    const sortedVitals = [...c.vitals]
        .filter((v) => new Date(v.measured_at).getTime() >= since.getTime())
        .sort((a, b) => String(a.measured_at).localeCompare(String(b.measured_at)));
    for (const v of sortedVitals) {
        const row = { type: v.type, value: num(v.value), value2: v.value2 === null ? null : num(v.value2), unit: v.unit, measured_at: v.measured_at };
        const list = seriesByType.get(v.type);
        if (list) list.push(row);
        else seriesByType.set(v.type, [row]);
    }
    const vitalsSeries = Array.from(seriesByType.entries()).map(([type, values]) => ({
        type, unit: values[values.length - 1].unit, count: values.length,
        first: values[0], last: values[values.length - 1], values,
    }));

    const intakes = intakesForRange(c, isoDate(since), isoDate(until), 120);
    const summary = {
        scheduled: intakes.length,
        taken: intakes.filter((i) => i.status === 'taken').length,
        skipped: intakes.filter((i) => i.status === 'skipped').length,
        missed: intakes.filter((i) => i.status === 'missed').length,
    };
    const missedDoses = intakes
        .filter((i) => i.status === 'missed')
        .sort((a, b) => String(b.due_at).localeCompare(String(a.due_at)))
        .slice(0, 50)
        .map((i) => ({ due_at: i.due_at, medication_name: i.medication_name, dosage: i.dosage }));

    const r = c.recipient || {};
    return {
        recipient: c.recipient
            ? {
                first_name: r.first_name, last_name: r.last_name, birth_date: r.birth_date,
                blood_type: r.blood_type, allergies: r.allergies, medical_history: r.medical_history,
                gp_name: r.gp_name, gp_phone: r.gp_phone,
            }
            : null,
        period: { since: since.toISOString(), until: until.toISOString() },
        journal_highlights: highlights,
        vitals_series: vitalsSeries,
        medications_current: c.medications
            .filter((m) => m.active !== false)
            .map((m) => ({
                id: m.id, name: m.name, dosage: m.dosage, form: m.form,
                instructions: m.instructions, prescriber: m.prescriber,
                schedules: ((m.schedules as Json[]) || []).map((s) => ({
                    time_of_day: s.time_of_day, days_of_week: s.days_of_week, label: s.label,
                })),
            })),
        intakes_summary: summary,
        missed_doses: missedDoses,
        prescriptions: c.prescriptions.map((p) => ({
            id: p.id, title: p.title, prescribed_by: p.prescribed_by,
            issued_date: p.issued_date, renewal_date: p.renewal_date,
        })),
    };
}

// ── Messagerie ───────────────────────────────────────────────────────────────

const ATTACHMENT_RE = /^data:([a-z0-9.+/-]+);base64,/i;

function dmConversations(c: CircleData): Json[] {
    const me = store.user.id as string;
    const usersById = new Map(store.users.map((u) => [u.id as string, u]));
    const dms = c.messages
        .filter((m) => m.channel === 'dm' && (m.author_user_id === me || m.recipient_user_id === me))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const seen = new Set<string>();
    const out: Json[] = [];
    for (const m of dms) {
        const otherId = m.author_user_id === me ? m.recipient_user_id : m.author_user_id;
        if (!otherId || seen.has(otherId)) continue;
        seen.add(otherId);
        const other = usersById.get(otherId);
        out.push({
            other_user_id: otherId,
            other_user_name: other ? other.name : 'Membre',
            other_user_avatar: other ? other.avatar_url : null,
            last_message_id: m.id,
            last_author_user_id: m.author_user_id,
            last_message: m.content,
            last_message_at: m.created_at,
        });
    }
    return out;
}

// ── Routeur ──────────────────────────────────────────────────────────────────

async function route(method: string, path: string, q: Record<string, string>, body: Json): Promise<unknown> {
    const seg = path.split('/').filter(Boolean); // ex: ['api', 'tasks', '123']
    const c = activeCircle();

    // ── Auth ─────────────────────────────────────────────────────────────────
    if (path === '/api/auth/me') return ok({ user: store.user });
    if (path === '/api/auth/login' || path === '/api/auth/register' || path === '/api/auth/refresh') {
        return ok({ token: 'demo-token', user: store.user });
    }
    if (path === '/api/auth/profile') {
        if (typeof body.name === 'string' && body.name.trim()) store.user.name = body.name.trim();
        if ('avatar_url' in body) store.user.avatar_url = body.avatar_url ?? null;
        return ok({ user: store.user });
    }
    if (path === '/api/auth/language') {
        if (body.language !== 'fr' && body.language !== 'en') throw new Error('Invalid language'); // 400 du serveur
        store.user.language = body.language;
        return ok({ user: store.user });
    }

    // ── Cercles ──────────────────────────────────────────────────────────────
    if (path === '/api/circles' && method === 'GET') return ok(store.circles.map(circleSummary));
    if (path === '/api/circles' && method === 'POST') {
        const first = typeof body.recipient_first_name === 'string' ? body.recipient_first_name.trim() : '';
        const name = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim() : first || 'Proche';
        const created = makeCircle(name, {
            first_name: first || name,
            last_name: typeof body.recipient_last_name === 'string' ? body.recipient_last_name.trim() || null : null,
            birth_date: body.recipient_birth_date || null,
        });
        store.circles.push(created);
        return ok({ circle: circleRow(created), recipient: created.recipient });
    }
    if (seg[1] === 'circles' && seg.length >= 3) {
        const target = circleById(seg[2]);
        if (target) {
            if (seg.length === 3 && method === 'GET') {
                return ok({ circle: circleRow(target), recipient: target.recipient, members: target.members, my_role: target.role });
            }
            if (seg.length === 3 && method === 'PUT') {
                if (typeof body.name === 'string' && body.name.trim()) target.name = body.name.trim();
                if (typeof body.currency === 'string' && body.currency.length === 3) target.currency = body.currency.toUpperCase();
                if (body.settings && typeof body.settings === 'object') target.settings = body.settings;
                return ok(circleRow(target));
            }
            if (seg.length === 3 && method === 'DELETE') {
                removeFrom(store.circles as unknown as Json[], target.id);
                return ok({});
            }
            if (seg[3] === 'members' && seg.length === 5) {
                if (method === 'PUT') {
                    const patch: Json = {};
                    if (typeof body.role === 'string') patch.role = body.role;
                    if (typeof body.color === 'string') patch.color = body.color;
                    return ok(updateIn(target.members, seg[4], patch));
                }
                if (method === 'DELETE') { removeFrom(target.members, seg[4]); return ok({}); }
            }
            if (seg[3] === 'recipient') {
                if (method === 'GET') return ok(target.recipient);
                if (method === 'PUT') {
                    target.recipient = { ...target.recipient, ...body, updated_at: naiveNow() };
                    return ok(target.recipient);
                }
            }
        }
    }

    // ── Invitations ──────────────────────────────────────────────────────────
    if (path === '/api/invites' && method === 'GET') return ok(c.invites.filter((i) => i.status === 'pending'));
    if (path === '/api/invites' && method === 'POST') {
        const invite = {
            id: uid(), circle_id: c.id, token: 'demo-invite-' + uid().slice(0, 8),
            invitee_email: typeof body.invitee_email === 'string' && body.invitee_email.trim() ? body.invitee_email.trim() : null,
            role: typeof body.role === 'string' ? body.role : 'family',
            status: 'pending',
            expires_at: toLocalISO(new Date(Date.now() + (num(body.expires_in_days) || 7) * 86400000)),
            created_at: naiveNow(), created_by_name: store.user.name,
        };
        c.invites.unshift(invite);
        return ok(invite);
    }
    if (seg[1] === 'invites' && seg[2] === 'info' && seg.length === 4) {
        const found = store.circles.flatMap((circle) => circle.invites).find((i) => i.token === seg[3]);
        const home = found ? store.circles.find((circle) => circle.id === found.circle_id) : undefined;
        return ok({
            role: found ? found.role : 'family',
            invitee_email: found ? found.invitee_email : null,
            expires_at: found ? found.expires_at : toLocalISO(new Date(Date.now() + 7 * 86400000)),
            circle_name: home ? home.name : c.name,
            recipient_first_name: home && home.recipient ? home.recipient.first_name : (c.recipient ? c.recipient.first_name : null),
            inviter_name: store.user.name,
        });
    }
    if (seg[1] === 'invites' && seg[2] === 'accept') return ok({ circle_id: c.id });
    if (seg[1] === 'invites' && seg.length === 3 && method === 'DELETE') { removeFrom(c.invites, seg[2]); return ok({}); }

    // ── Liens magiques (intervenants sans compte) ────────────────────────────
    if (path === '/api/caregiver-links' && method === 'GET') return ok(c.caregiverLinks);
    if (path === '/api/caregiver-links' && method === 'POST') {
        const token = 'demo-lien-' + uid().slice(0, 8);
        const link = {
            id: uid(), circle_id: c.id, token,
            display_name: typeof body.display_name === 'string' ? body.display_name.trim() : 'Intervenant',
            role_label: typeof body.role_label === 'string' && body.role_label.trim() ? body.role_label.trim() : null,
            created_by: store.user.id, created_by_name: store.user.name,
            revoked: false,
            expires_at: body.expires_in_days ? toLocalISO(new Date(Date.now() + num(body.expires_in_days) * 86400000)) : null,
            last_used_at: null, created_at: naiveNow(), status: 'active',
        };
        c.caregiverLinks.unshift(link);
        return ok({ ...link, url: `/care/${token}` });
    }
    if (seg[1] === 'caregiver-links' && seg.length === 3) {
        if (method === 'PUT') {
            const updated = updateIn(c.caregiverLinks, seg[2], body);
            if (updated) updated.status = updated.revoked ? 'revoked' : 'active';
            return ok(updated);
        }
        if (method === 'DELETE') { removeFrom(c.caregiverLinks, seg[2]); return ok({}); }
    }

    // ── Journal de liaison ───────────────────────────────────────────────────
    if (path === '/api/journal' && method === 'GET') {
        let list = journalDesc(c);
        if (q.type) list = list.filter((e) => e.type === q.type);
        if (q.author) list = list.filter((e) => e.author_user_id === q.author);
        if (q.before) {
            const before = new Date(q.before).getTime();
            list = list.filter((e) => new Date(e.occurred_at).getTime() < before);
        }
        const limit = Math.min(Math.max(parseInt(q.limit || '50', 10) || 50, 1), 200);
        return ok(list.slice(0, limit));
    }
    if (path === '/api/journal' && method === 'POST') {
        const entryId = uid();
        const photos = (Array.isArray(body.photos) ? body.photos : []).map((dataUrl: string) => ({
            id: uid(), entry_id: entryId, file_path: dataUrl,
            mime_type: 'image/jpeg', size_bytes: Math.floor((String(dataUrl).length * 3) / 4),
            created_at: naiveNow(),
        }));
        const data: Json = body.data && typeof body.data === 'object' ? body.data : {};
        const entry = {
            id: entryId, circle_id: c.id, author_user_id: store.user.id, caregiver_link_id: null,
            author_name: store.user.name, type: body.type || 'note', content: typeof body.content === 'string' ? body.content : '',
            data, occurred_at: body.occurred_at || naiveNow(), created_at: naiveNow(), photos,
        };
        c.journal.unshift(entry);
        // Comme le serveur : une entrée 'vital' structurée alimente aussi les constantes.
        if (entry.type === 'vital' && data.vital_type) {
            c.vitals.push({
                id: uid(), circle_id: c.id, type: data.vital_type, value: num(data.value),
                value2: data.value2 === undefined || data.value2 === null ? null : num(data.value2),
                unit: data.unit ?? null, measured_at: entry.occurred_at, journal_entry_id: entryId,
                recorded_by_user: store.user.id, notes: null, created_at: naiveNow(),
            });
        }
        return ok(entry);
    }
    if (seg[1] === 'journal' && seg.length === 3) {
        if (method === 'PUT') return ok(updateIn(c.journal, seg[2], body));
        if (method === 'DELETE') { removeFrom(c.journal, seg[2]); return ok({}); }
    }

    // ── Constantes ───────────────────────────────────────────────────────────
    if (path === '/api/vitals/latest') return ok(latestVitals(c));
    if (path === '/api/vitals' && method === 'GET') {
        let list = [...c.vitals];
        if (q.type) list = list.filter((v) => v.type === q.type);
        if (q.from) {
            const from = new Date(q.from).getTime();
            list = list.filter((v) => new Date(v.measured_at).getTime() >= from);
        }
        if (q.to) {
            const to = new Date(q.to).getTime();
            list = list.filter((v) => new Date(v.measured_at).getTime() <= to);
        }
        list.sort((a, b) => String(a.measured_at).localeCompare(String(b.measured_at)));
        return ok(list);
    }
    if (path === '/api/vitals' && method === 'POST') {
        const vitalRow = {
            id: uid(), circle_id: c.id, type: body.type, value: num(body.value),
            value2: body.value2 === undefined || body.value2 === null || body.value2 === '' ? null : num(body.value2),
            unit: body.unit || null, measured_at: body.measured_at || naiveNow(),
            journal_entry_id: null, recorded_by_user: store.user.id,
            notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
            created_at: naiveNow(),
        };
        c.vitals.push(vitalRow);
        return ok(vitalRow);
    }
    if (seg[1] === 'vitals' && seg.length === 3) {
        if (method === 'PUT') return ok(updateIn(c.vitals, seg[2], body));
        if (method === 'DELETE') { removeFrom(c.vitals, seg[2]); return ok({}); }
    }

    // ── Médicaments, prises, ordonnances ─────────────────────────────────────
    if (path === '/api/medications/intakes' && method === 'GET') {
        const today = isoDate(new Date());
        const from = q.from || today;
        const to = q.to || from;
        return ok(intakesForRange(c, from, to));
    }
    if (seg[1] === 'medications' && seg[2] === 'intakes' && seg.length === 4 && method === 'PUT') {
        const updated = setIntakeStatus(c, seg[3], body.status);
        return ok(updated ?? {});
    }
    if (path === '/api/medications/prescriptions' && method === 'GET') {
        const list = [...c.prescriptions].sort((a, b) => String(a.renewal_date || '9999').localeCompare(String(b.renewal_date || '9999')));
        return ok(list);
    }
    if (path === '/api/medications/prescriptions' && method === 'POST') {
        const rx = {
            id: uid(), circle_id: c.id, title: body.title, prescribed_by: body.prescribed_by || null,
            issued_date: body.issued_date || null, renewal_date: body.renewal_date || null,
            reminder_days: body.reminder_days ?? 7, document_id: body.document_id || null,
            notes: body.notes || null, created_at: naiveNow(), updated_at: naiveNow(),
        };
        c.prescriptions.unshift(rx);
        return ok(rx);
    }
    if (seg[1] === 'medications' && seg[2] === 'prescriptions' && seg.length === 4) {
        if (method === 'PUT') return ok(updateIn(c.prescriptions, seg[3], { ...body, updated_at: naiveNow() }));
        if (method === 'DELETE') { removeFrom(c.prescriptions, seg[3]); return ok({}); }
    }
    if (path === '/api/medications' && method === 'GET') {
        const active = q.active || 'true';
        let list = [...c.medications];
        if (active !== 'all') list = list.filter((m) => Boolean(m.active) === (active === 'true'));
        list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return ok(list);
    }
    if (path === '/api/medications' && method === 'POST') {
        const medId = uid();
        const med = {
            id: medId, circle_id: c.id, name: body.name, dosage: body.dosage || null, form: body.form || null,
            instructions: body.instructions || null, photo_url: body.photo_url || null,
            prescriber: body.prescriber || null, start_date: body.start_date || null, end_date: body.end_date || null,
            active: true, created_at: naiveNow(),
            schedules: (Array.isArray(body.schedules) ? body.schedules : []).map((s: Json) => ({
                id: uid(), medication_id: medId, time_of_day: s.time_of_day,
                days_of_week: Array.isArray(s.days_of_week) && s.days_of_week.length > 0 ? s.days_of_week : [1, 2, 3, 4, 5, 6, 7],
                label: s.label || null,
            })),
        };
        c.medications.push(med);
        return ok(med);
    }
    if (seg[1] === 'medications' && seg.length === 3) {
        if (method === 'PUT') {
            const patch: Json = { ...body };
            if (Array.isArray(body.schedules)) {
                patch.schedules = body.schedules.map((s: Json) => ({
                    id: s.id || uid(), medication_id: seg[2], time_of_day: s.time_of_day,
                    days_of_week: Array.isArray(s.days_of_week) && s.days_of_week.length > 0 ? s.days_of_week : [1, 2, 3, 4, 5, 6, 7],
                    label: s.label || null,
                }));
            }
            return ok(updateIn(c.medications, seg[2], patch));
        }
        if (method === 'DELETE') { removeFrom(c.medications, seg[2]); return ok({}); }
    }

    // ── Calendrier (événements) ──────────────────────────────────────────────
    if (path === '/api/events/upcoming') {
        const from = new Date();
        const to = new Date(from.getTime() + 30 * 86400000);
        return ok(expandEvents(c, from, to).slice(0, 10));
    }
    if (path === '/api/events' && method === 'GET') {
        const now = new Date();
        const from = q.from ? parseDayParam(q.from, false) : new Date(now.getFullYear(), now.getMonth(), 1);
        const to = q.to ? parseDayParam(q.to, true) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        return ok(expandEvents(c, from, to));
    }
    if (path === '/api/events' && method === 'POST') {
        const ev = {
            id: uid(), circle_id: c.id, title: body.title, description: body.description || null,
            category: body.category || 'other', start_time: body.start_time, end_time: body.end_time || null,
            location: body.location || null, rrule: body.rrule || null,
            member_ids: Array.isArray(body.member_ids) ? body.member_ids : [],
            reminder_30min: Boolean(body.reminder_30min), reminder_1hour: Boolean(body.reminder_1hour),
            notes: body.notes || null, created_by: store.user.id, created_at: naiveNow(),
        };
        c.events.unshift(ev);
        return ok(ev);
    }
    if (seg[1] === 'events' && seg.length === 3) {
        if (method === 'PUT') return ok(updateIn(c.events, seg[2], body));
        if (method === 'DELETE') { removeFrom(c.events, seg[2]); return ok({}); }
    }
    if (path === '/api/calendar/token' && method === 'GET') return ok({ token: store.calendarToken });
    if (path === '/api/calendar/token' && method === 'POST') {
        store.calendarToken = 'demo-ical-' + uid().slice(0, 8);
        return ok({ token: store.calendarToken });
    }

    // ── Tâches ───────────────────────────────────────────────────────────────
    if (path === '/api/tasks' && method === 'GET') return ok(sortTasks(c.tasks).map((t) => enrichTask(c, t)));
    if (path === '/api/tasks/statistics') {
        const total = c.tasks.length;
        const completed = c.tasks.filter((t) => t.is_completed).length;
        const byCategory: Record<string, number> = {};
        for (const t of c.tasks) {
            if (!t.is_completed) byCategory[t.category || 'other'] = (byCategory[t.category || 'other'] || 0) + 1;
        }
        return ok({
            total, completed, pending: total - completed,
            completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
            byCategory,
        });
    }
    if (path === '/api/tasks' && method === 'POST') {
        const task = {
            id: uid(), circle_id: c.id, title: body.title, description: body.description || null,
            category: body.category || 'other', is_completed: false,
            due_date: body.due_date || null, frequency: body.frequency || null, priority: body.priority || null,
            assigned_to: Array.isArray(body.assigned_to) ? body.assigned_to : [],
            completed_at: null, completed_by: null, created_at: naiveNow(),
        };
        c.tasks.unshift(task);
        return ok(enrichTask(c, task));
    }
    if (seg[1] === 'tasks' && seg.length === 4 && seg[3] === 'complete' && method === 'PUT') {
        const task = c.tasks.find((t) => t.id === seg[2]);
        if (!task) return ok({});
        const wasCompleted = Boolean(task.is_completed);
        const isCompleted = body.is_completed !== undefined ? Boolean(body.is_completed) : !wasCompleted;
        if (isCompleted !== wasCompleted) {
            task.is_completed = isCompleted;
            task.completed_at = isCompleted ? naiveNow() : null;
            task.completed_by = isCompleted ? store.user.id : null;
        }
        return ok(enrichTask(c, task));
    }
    if (seg[1] === 'tasks' && seg.length === 3) {
        if (method === 'PUT') {
            const existing = c.tasks.find((t) => t.id === seg[2]);
            const wasCompleted = Boolean(existing && existing.is_completed);
            const updated = updateIn(c.tasks, seg[2], body);
            if (updated && body.is_completed !== undefined && Boolean(body.is_completed) !== wasCompleted) {
                updated.completed_at = body.is_completed ? naiveNow() : null;
                updated.completed_by = body.is_completed ? store.user.id : null;
            }
            return ok(updated ? enrichTask(c, updated) : null);
        }
        if (method === 'DELETE') { removeFrom(c.tasks, seg[2]); return ok({}); }
    }

    // ── Courses ──────────────────────────────────────────────────────────────
    if (path === '/api/shopping' && method === 'GET') {
        return ok([...c.shopping].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
    }
    if (path === '/api/shopping' && method === 'POST') {
        const item = {
            id: uid(), circle_id: c.id, name: body.name, category: body.category || 'other',
            quantity: body.quantity ?? null, unit: body.unit || null, notes: body.notes || null,
            is_checked: false, added_by: store.user.id, created_at: naiveNow(),
        };
        c.shopping.unshift(item);
        return ok(item);
    }
    if (path === '/api/shopping/checked/clear' && method === 'DELETE') {
        for (let i = c.shopping.length - 1; i >= 0; i--) {
            if (c.shopping[i].is_checked) c.shopping.splice(i, 1);
        }
        return ok({});
    }
    if (seg[1] === 'shopping' && seg.length === 3) {
        if (method === 'PUT') return ok(updateIn(c.shopping, seg[2], body));
        if (method === 'DELETE') { removeFrom(c.shopping, seg[2]); return ok({}); }
    }

    // ── Messagerie ───────────────────────────────────────────────────────────
    if (path === '/api/messages/dm' && method === 'GET') return ok(dmConversations(c));
    if (seg[1] === 'messages' && seg[2] === 'dm' && seg.length === 4 && method === 'GET') {
        const me = store.user.id;
        const other = seg[3];
        let list = c.messages
            .filter((m) => m.channel === 'dm'
                && ((m.author_user_id === me && m.recipient_user_id === other)
                    || (m.author_user_id === other && m.recipient_user_id === me)))
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        if (q.before) {
            const before = new Date(q.before).getTime();
            list = list.filter((m) => new Date(m.created_at).getTime() < before);
        }
        return ok(list.slice(0, Math.min(parseInt(q.limit || '50', 10) || 50, 200)));
    }
    if (path === '/api/messages' && method === 'GET') {
        let list = c.messages
            .filter((m) => m.channel === 'circle')
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        if (q.before) {
            const before = new Date(q.before).getTime();
            list = list.filter((m) => new Date(m.created_at).getTime() < before);
        }
        return ok(list.slice(0, Math.min(parseInt(q.limit || '50', 10) || 50, 200)));
    }
    if (path === '/api/messages' && method === 'POST') {
        const channel = body.channel === 'dm' ? 'dm' : 'circle';
        const attachments = (Array.isArray(body.attachments) ? body.attachments : []).map((a: Json) => {
            const match = typeof a.data === 'string' ? a.data.match(ATTACHMENT_RE) : null;
            return { name: a.name || 'fichier', path: a.data, mime: match ? match[1].toLowerCase() : 'application/octet-stream' };
        });
        const message = {
            id: uid(), circle_id: c.id, channel,
            author_user_id: store.user.id,
            recipient_user_id: channel === 'dm' ? body.recipient_user_id || null : null,
            content: typeof body.content === 'string' ? body.content.trim() : '',
            attachments, edited_at: null, created_at: naiveNow(),
            author_name: store.user.name, author_avatar: store.user.avatar_url ?? null,
        };
        c.messages.unshift(message);
        return ok(message);
    }
    if (seg[1] === 'messages' && seg.length === 3) {
        if (method === 'PUT') return ok(updateIn(c.messages, seg[2], { content: body.content, edited_at: naiveNow() }));
        if (method === 'DELETE') { removeFrom(c.messages, seg[2]); return ok({}); }
    }

    // ── Documents ────────────────────────────────────────────────────────────
    if (path === '/api/documents' && method === 'GET') {
        let list = [...c.documents].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        if (q.category) list = list.filter((d) => d.category === q.category);
        return ok(list.map(({ file_path, ...rest }) => rest));
    }
    if (path === '/api/documents' && method === 'POST') {
        const match = typeof body.file === 'string' ? body.file.match(ATTACHMENT_RE) : null;
        const doc = {
            id: uid(), circle_id: c.id, title: body.title, category: body.category || 'other',
            file_path: body.file, mime_type: match ? match[1].toLowerCase() : 'application/octet-stream',
            size_bytes: Math.floor((String(body.file || '').length * 3) / 4),
            uploaded_by: store.user.id, uploaded_by_name: store.user.name,
            notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
            created_at: naiveNow(),
        };
        c.documents.unshift(doc);
        const { file_path, ...rest } = doc;
        return ok(rest);
    }
    if (seg[1] === 'documents' && seg.length === 3) {
        if (method === 'GET') return ok(c.documents.find((d) => d.id === seg[2]) ?? null);
        if (method === 'PUT') {
            const updated = updateIn(c.documents, seg[2], body);
            if (!updated) return ok(null);
            const { file_path, ...rest } = updated;
            return ok(rest);
        }
        if (method === 'DELETE') { removeFrom(c.documents, seg[2]); return ok({}); }
    }

    // ── Contacts ─────────────────────────────────────────────────────────────
    if (path === '/api/contacts' && method === 'GET') {
        return ok([...c.contacts].sort((a, b) => String(a.name).localeCompare(String(b.name))));
    }
    if (path === '/api/contacts' && method === 'POST') {
        const contact = {
            id: uid(), circle_id: c.id, name: body.name, category: body.category || 'other',
            organization: body.organization || null, phone: body.phone || null, phone2: body.phone2 || null,
            email: body.email || null, address: body.address || null,
            has_key: body.has_key === true, notes: body.notes || null, created_at: naiveNow(),
        };
        c.contacts.unshift(contact);
        return ok(contact);
    }
    if (seg[1] === 'contacts' && seg.length === 3) {
        if (method === 'PUT') return ok(updateIn(c.contacts, seg[2], body));
        if (method === 'DELETE') { removeFrom(c.contacts, seg[2]); return ok({}); }
    }

    // ── Frais partagés ───────────────────────────────────────────────────────
    if (path === '/api/expenses/balances') return ok(computeBalances(c));
    if (path === '/api/expenses/summary') return ok(expensesSummary(c));
    if (path === '/api/expenses/settlements' && method === 'GET') {
        return ok([...c.settlements].sort((a, b) => String(b.date).localeCompare(String(a.date))));
    }
    if (path === '/api/expenses/settlements' && method === 'POST') {
        const membersById = new Map(c.members.map((m) => [m.id as string, m]));
        const fromMember = membersById.get(body.from_member);
        const toMember = membersById.get(body.to_member);
        const settlement = {
            id: uid(), circle_id: c.id, from_member: body.from_member, to_member: body.to_member,
            from_member_name: fromMember ? fromMember.name : 'Membre',
            to_member_name: toMember ? toMember.name : 'Membre',
            amount: num(body.amount), date: body.date || isoDate(new Date()),
            note: body.note || null, created_at: naiveNow(),
        };
        c.settlements.unshift(settlement);
        return ok(settlement);
    }
    if (seg[1] === 'expenses' && seg[2] === 'settlements' && seg.length === 4 && method === 'DELETE') {
        removeFrom(c.settlements, seg[3]);
        return ok({});
    }
    if (path === '/api/expenses/aids' && method === 'GET') return ok(c.aids);
    if (path === '/api/expenses/aids' && method === 'POST') {
        const aid = {
            id: uid(), circle_id: c.id, type: body.type, label: body.label || null, amount: num(body.amount),
            period_start: body.period_start || null, period_end: body.period_end || null,
            notes: body.notes || null, created_at: naiveNow(),
        };
        c.aids.unshift(aid);
        return ok(aid);
    }
    if (seg[1] === 'expenses' && seg[2] === 'aids' && seg.length === 4) {
        if (method === 'PUT') return ok(updateIn(c.aids, seg[3], body));
        if (method === 'DELETE') { removeFrom(c.aids, seg[3]); return ok({}); }
    }
    if (path === '/api/expenses' && method === 'GET') {
        let list = [...c.expenses].sort((a, b) => String(b.date).localeCompare(String(a.date)));
        if (q.from) list = list.filter((e) => String(e.date) >= q.from);
        if (q.to) list = list.filter((e) => String(e.date) <= q.to);
        if (q.category) list = list.filter((e) => e.category === q.category);
        return ok(list);
    }
    if (path === '/api/expenses' && method === 'POST') {
        const sharing = c.members.filter((m) => m.role === 'admin' || m.role === 'family');
        const mine = myMemberIn(c);
        const paidBy = typeof body.paid_by === 'string' && body.paid_by ? body.paid_by : (mine ? mine.id : sharing[0]?.id);
        const payer = c.members.find((m) => m.id === paidBy);
        const amount = num(body.amount);
        const splits = body.split_mode === 'custom' && Array.isArray(body.splits)
            ? body.splits.map((s: Json) => ({ member_id: s.member_id, share: num(s.share) }))
            : equalSplits(amount, sharing.map((m) => m.id as string));
        const expense = {
            id: uid(), circle_id: c.id, paid_by: paidBy, paid_by_name: payer ? payer.name : 'Membre',
            amount, category: body.category || 'other', description: body.description || null,
            date: body.date || isoDate(new Date()), document_id: body.document_id || null,
            split_mode: body.split_mode === 'custom' ? 'custom' : 'equal', splits, created_at: naiveNow(),
        };
        c.expenses.unshift(expense);
        return ok(expense);
    }
    if (seg[1] === 'expenses' && seg.length === 3) {
        if (method === 'PUT') {
            const existing = c.expenses.find((e) => e.id === seg[2]);
            if (!existing) return ok(null);
            const merged = { ...existing, ...body };
            const sharing = c.members.filter((m) => m.role === 'admin' || m.role === 'family');
            merged.amount = num(merged.amount);
            merged.splits = merged.split_mode === 'custom' && Array.isArray(merged.splits)
                ? (merged.splits as Json[]).map((s) => ({ member_id: s.member_id, share: num(s.share) }))
                : equalSplits(merged.amount, sharing.map((m) => m.id as string));
            const payer = c.members.find((m) => m.id === merged.paid_by);
            merged.paid_by_name = payer ? payer.name : merged.paid_by_name;
            return ok(updateIn(c.expenses, seg[2], merged));
        }
        if (method === 'DELETE') { removeFrom(c.expenses, seg[2]); return ok({}); }
    }

    // ── Tableau de bord ──────────────────────────────────────────────────────
    if (path === '/api/dashboard') return ok(dashboard(c));

    // ── Notes (post-its du cercle) ───────────────────────────────────────────
    if (path === '/api/notes' && method === 'GET') {
        const cutoff = naiveNow();
        const list = c.notes.filter((n) => !n.expires_at || String(n.expires_at) > cutoff);
        return ok([...list].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
    }
    if (path === '/api/notes' && method === 'POST') {
        const note = {
            id: uid(), circle_id: c.id, author_name: store.user.name,
            content: String(body.content || '').trim().slice(0, 500),
            color: body.color || 'yellow', expires_at: body.expires_at || null, created_at: naiveNow(),
        };
        c.notes.unshift(note);
        return ok(note);
    }
    if (seg[1] === 'notes' && seg.length === 3) {
        if (method === 'PUT') return ok(updateIn(c.notes, seg[2], body));
        if (method === 'DELETE') { removeFrom(c.notes, seg[2]); return ok({}); }
    }

    // ── Notifications ────────────────────────────────────────────────────────
    if (path === '/api/notifications' && method === 'GET') return ok(store.notifications);
    if (path === '/api/notifications/unread-count') {
        return ok({ count: store.notifications.filter((n) => !n.is_read).length });
    }
    if (path === '/api/notifications/vapid-public-key') return ok('');
    if (path === '/api/notifications/subscribe') return ok({});
    if (path === '/api/notifications/read-all') {
        for (const n of store.notifications) n.is_read = true;
        return ok({});
    }
    if (seg[1] === 'notifications' && seg.length === 4 && seg[3] === 'read') {
        updateIn(store.notifications, seg[2], { is_read: true });
        return ok({});
    }

    // ── Insights : équité de la charge + préparation de consultation ────────
    if (path === '/api/insights/equity') {
        const months = [1, 3, 12].includes(parseInt(q.months || '1', 10)) ? parseInt(q.months || '1', 10) : 1;
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
        const previousStart = new Date(now.getFullYear(), now.getMonth() - (2 * months - 1), 1);
        const current = withTotals(equityWindow(c, start, now));
        const previous = withTotals(equityWindow(c, previousStart, start));
        return ok({
            months,
            period: { start: start.toISOString(), end: now.toISOString() },
            previous_period: { start: previousStart.toISOString(), end: start.toISOString() },
            members: current.members,
            totals: current.totals,
            previous_members: previous.members,
            previous_totals: previous.totals,
        });
    }
    if (path === '/api/insights/consultation') return ok(consultation(c, q.since));

    // ── Page « Qui je suis » ─────────────────────────────────────────────────
    if (path === '/api/story' && method === 'GET') return ok(c.story);
    if (path === '/api/story' && method === 'PUT') {
        c.story = { ...c.story, sections: Array.isArray(body.sections) ? body.sections : [], updated_by: store.user.id, updated_at: naiveNow() };
        return ok(c.story);
    }

    // ── Fiche urgence ────────────────────────────────────────────────────────
    if (path === '/api/emergency/sheet' && method === 'GET') {
        return ok({ ...c.emergencySheet, url: `/urgence/${c.emergencySheet.public_token}` });
    }
    if (path === '/api/emergency/sheet' && method === 'PUT') {
        if (typeof body.enabled === 'boolean') c.emergencySheet.enabled = body.enabled;
        if (typeof body.extra_notes === 'string' || body.extra_notes === null) {
            c.emergencySheet.extra_notes = body.extra_notes === '' ? null : body.extra_notes;
        }
        if (body.regenerate_token === true) c.emergencySheet.public_token = 'demo-urgence-' + uid().slice(0, 8);
        c.emergencySheet.updated_at = naiveNow();
        return ok({ ...c.emergencySheet, url: `/urgence/${c.emergencySheet.public_token}` });
    }
    if (seg[1] === 'emergency' && seg[2] === 'public' && seg.length === 4) {
        const home = store.circles.find((circle) => circle.emergencySheet.public_token === seg[3] && circle.emergencySheet.enabled) ?? c;
        return ok({
            recipient: home.recipient ?? null,
            medications: home.medications
                .filter((m) => m.active !== false)
                .map((m) => ({
                    name: m.name, dosage: m.dosage, form: m.form,
                    schedules: ((m.schedules as Json[]) || []).map((s) => ({ time: s.time_of_day, label: s.label })),
                })),
            contacts: home.contacts.filter((ct) => ct.phone).slice(0, 8),
            extra_notes: home.emergencySheet.extra_notes,
            updated_at: home.emergencySheet.updated_at,
        });
    }

    // ── Synthèses hebdo ──────────────────────────────────────────────────────
    if (path === '/api/digests' && method === 'GET') return ok(c.digests);
    if (path === '/api/digests/generate' && method === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 900));
        const now = new Date();
        const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
        const weekStart = isoDate(monday);
        const recipientName = c.recipient ? c.recipient.first_name : 'votre proche';
        const digest = {
            id: uid(), circle_id: c.id, week_start: weekStart,
            content: `Synthèse de la semaine pour ${recipientName} (générée à la demande dans la démo).\n\nLe journal montre un rythme régulier : passages de l'auxiliaire le matin, visites de la famille en fin de journée. Le moral est stable et l'appétit correct.\n\nSanté : constantes dans les valeurs habituelles, observance des traitements satisfaisante en dehors d'un oubli.\n\nÀ surveiller : rien d'urgent. Pensez au prochain renouvellement d'ordonnance.`,
            created_at: naiveNow(),
        };
        const existing = c.digests.findIndex((dg) => dg.week_start === weekStart);
        if (existing >= 0) c.digests[existing] = digest;
        else c.digests.unshift(digest);
        return ok(digest);
    }

    // ── Veille passive (présence) ────────────────────────────────────────────
    if (path === '/api/presence/status') {
        const today = isoDate(new Date());
        const signals = [...c.presenceSignals].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
        const todayCount = signals.filter((s) => String(s.occurred_at).startsWith(today)).length;
        return ok({
            today_signal_count: todayCount,
            last_signal: signals[0] ?? null,
            normal_activity: todayCount > 0,
            rule: c.presenceRule,
            webhook_url: c.presenceWebhookUrl,
        });
    }
    if (path === '/api/presence/signals') {
        return ok([...c.presenceSignals].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, 50));
    }
    if (path === '/api/presence/rule' && method === 'PUT') {
        c.presenceRule = {
            id: c.presenceRule ? c.presenceRule.id : uid(),
            enabled: Boolean(body.enabled),
            no_activity_before: body.no_activity_before || '10:00',
            alert_member_ids: Array.isArray(body.alert_member_ids) ? body.alert_member_ids : [],
            last_alert_date: c.presenceRule ? c.presenceRule.last_alert_date : null,
        };
        return ok(c.presenceRule);
    }
    if (path === '/api/presence/webhook-token' && method === 'POST') {
        c.presenceWebhookUrl = `/api/presence/webhook/${c.id}/demo-webhook-` + uid().slice(0, 8);
        return ok({ webhook_url: c.presenceWebhookUrl });
    }

    // ── Kiosk ────────────────────────────────────────────────────────────────
    if (path === '/api/kiosk/today') return ok(kioskToday(c));
    if (path === '/api/kiosk/status' && method === 'POST') {
        const kind = body.kind === 'help' ? 'help' : 'ok';
        const firstName = c.recipient ? c.recipient.first_name : 'Kiosk';
        const entry = {
            id: uid(), circle_id: c.id, author_user_id: null, caregiver_link_id: null,
            author_name: firstName,
            type: kind === 'help' ? 'incident' : 'mood',
            content: kind === 'help'
                ? 'J\'ai besoin d\'aide (signal envoyé depuis le kiosk)'
                : 'Tout va bien (signal envoyé depuis le kiosk)',
            data: { source: 'kiosk', kind },
            occurred_at: naiveNow(), created_at: naiveNow(), photos: [],
        };
        c.journal.unshift(entry);
        if (kind === 'help') {
            store.notifications.unshift({
                id: uid(), user_id: store.user.id, circle_id: c.id,
                title: `${firstName} demande de l'aide`,
                message: `${firstName} a appuyé sur le bouton d'aide du kiosk. Pensez à prendre des nouvelles tout de suite.`,
                type: 'kiosk_help', related_id: entry.id, url: '/journal', is_read: false, created_at: naiveNow(),
            });
        }
        return ok(entry);
    }

    // ── Journal vocal (transcription factice) ────────────────────────────────
    if (path === '/api/voice/transcribe' && method === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return ok({ text: 'Passage de midi : Jeanne a bien mangé et le moral est bon. Penser à racheter du café moulu.' });
    }
    if (path === '/api/voice/journal' && method === 'POST') {
        const entry = {
            id: uid(), circle_id: c.id, author_user_id: store.user.id, caregiver_link_id: null,
            author_name: store.user.name, type: 'note',
            content: typeof body.text === 'string' ? body.text.trim() : '',
            data: { source: 'voice' }, occurred_at: naiveNow(), created_at: naiveNow(), photos: [],
        };
        c.journal.unshift(entry);
        return ok({ entry, shopping_items: [] });
    }

    // ── IA (la démo se présente comme configurée pour montrer les ✨) ────────
    if (path === '/api/ai/settings' && method === 'GET') {
        return ok({ configured: true, enabled: true, provider: 'ollama', base_url: 'http://localhost:11434', model: 'llama3.1', has_api_key: false });
    }
    if (path === '/api/ai/settings' && method === 'PUT') {
        return ok({
            configured: true,
            enabled: body.enabled !== false,
            provider: (body.provider as string) || 'ollama',
            base_url: (body.base_url as string) ?? null,
            model: (body.model as string) || 'llama3.1',
            has_api_key: Boolean(body.api_key),
        });
    }
    if (path === '/api/ai/test' && method === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return { success: true, message: 'OK' };
    }

    // ── Export / import ──────────────────────────────────────────────────────
    if (path === '/api/data/export') return ok(store);
    if (path === '/api/data/import') return ok({ imported: {} });

    // Repli : un succès vide pour que l'UI ne plante jamais en démo.
    return ok([]);
}

export async function mockRequest<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    // Petite latence simulée pour des transitions de chargement réalistes.
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 140));
    const path = stripQuery(endpoint);
    const q = queryParams(endpoint);
    const result = await route(method.toUpperCase(), path, q, (body as Json) || {});
    return result as T;
}
