// Backend simulé dans le navigateur pour la démo statique (GitHub Pages,
// VITE_DEMO=1). Pas de réseau, pas de persistance : le store est recréé à
// chaque chargement de page. Les réponses reproduisent la forme exacte de
// l'API réelle ({ success, data }) telle que renvoyée par server/src/routes.
//
// Le cercle actif est résolu depuis localStorage (la clé qu'utilise
// ApiClient.setCircleId), faute d'en-tête X-Circle-Id dans le mock.
import { createSeed, type CircleData, type DemoStore, type Json } from './seed';
import { detectIntent, answerIntent, hasDistressSignal, distressHint, type CompanionFactsInput, type CompanionLang } from './companionAnswers';

const store: DemoStore = createSeed();

// Ecran patient (demo) : appareils appaires et code aidant, en memoire.
const demoKiosk: { pinSet: boolean; pin: string; devices: Json[] } = {
    pinSet: false,
    pin: '',
    devices: [
        { id: 'dev-salon', name: 'Tablette du salon', kind: 'kiosk', last_seen_at: null, created_at: null },
    ],
};

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

// Noms de foyer (demo): keyes par household_id. Editables via PUT.
const demoHouseholdNames: Record<string, string> = { 'demo-foyer': 'Foyer Dupont' };

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
    household_id: c.household_id ?? null,
    household_name: c.household_id ? (demoHouseholdNames[c.household_id as string] ?? null) : null,
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
        invites: [], caregiverLinks: [], journal: [], vitals: [], medications: [], intakeOverrides: {}, prnIntakes: [], visits: [], carePlan: null, vitalThresholds: [], messageReads: {}, escalation: { enabled: false, med_patient_min: 15, med_primary_min: 30, med_secondary_min: 60, help_ack_min: 10, primary_member_ids: [], secondary_member_ids: [] }, helpRequests: [],
        prescriptions: [], events: [], tasks: [], shopping: [], messages: [], documents: [], contacts: [],
        expenses: [], settlements: [], aids: [], notes: [],
        story: { id: uid(), circle_id: id, sections: [], updated_by: null, updated_at: naiveNow(), created_at: naiveNow() },
        emergencySheet: { id: uid(), circle_id: id, public_token: 'demo-urgence-' + id.slice(0, 8), enabled: false, extra_notes: null, updated_at: naiveNow(), created_at: naiveNow() },
        digests: [], presenceSignals: [], presenceRule: null, presenceWebhookUrl: null,
        heatwave: null, household_id: null,
    };
}

// Etat canicule de demo (defauts si jamais configure sur ce cercle).
function heatwaveOf(c: CircleData): { enabled: boolean; active: boolean; level: 'orange' | 'red'; reminder_times: string[]; activated_at: string | null } {
    const h = (c.heatwave ?? null) as Record<string, unknown> | null;
    return {
        circle_id: c.id,
        enabled: Boolean(h?.enabled),
        active: Boolean(h?.active),
        level: h?.level === 'red' ? 'red' : 'orange',
        reminder_times: Array.isArray(h?.reminder_times) ? (h!.reminder_times as string[]) : ['10:00', '14:00', '17:00'],
        activated_at: typeof h?.activated_at === 'string' ? (h.activated_at as string) : null,
    } as { enabled: boolean; active: boolean; level: 'orange' | 'red'; reminder_times: string[]; activated_at: string | null };
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
            // Exception sur cette occurrence : sautee, ou deplacee ailleurs.
            const day = isoDate(d);
            const exception = (Array.isArray(ev.exceptions) ? ev.exceptions : []).find((e: Json) => e.date === day);
            if (exception?.action === 'skip') continue;
            let occStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), start.getHours(), start.getMinutes(), 0);
            let occEnd = durMs !== null ? new Date(occStart.getTime() + durMs) : null;
            if (exception?.action === 'move') {
                occStart = new Date(String(exception.start_time));
                occEnd = exception.end_time ? new Date(String(exception.end_time)) : (durMs !== null ? new Date(occStart.getTime() + durMs) : null);
            }
            const moved = exception?.action === 'move';
            out.push({
                ...ev,
                member_ids: Array.isArray(ev.member_ids) ? ev.member_ids : [],
                start_time: toLocalISO(occStart),
                end_time: occEnd ? toLocalISO(occEnd) : null,
                occurrence_date: day,
                is_recurring: true,
                moved,
                members_data: (Array.isArray(ev.member_ids) ? ev.member_ids : [])
                    .map((id: string) => membersById.get(id))
                    .filter(Boolean)
                    .map((m) => ({ id: m!.id, name: m!.name, color: m!.color, role: m!.role })),
            });
            continue;
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
        confirmed_source: override ? override.confirmed_source ?? (status === 'taken' ? 'caregiver' : null) : (status === 'taken' ? 'caregiver' : null),
        quantity: sch.quantity ?? 1, unit: sch.unit ?? null,
        journal_entry_id: override ? override.journal_entry_id ?? null : null,
        ...medicationDisplayFields(med),
        schedule_label: sch.label ?? null,
    };
}

/** Champs du medicament joints a chaque prise (meme liste que INTAKE_DISPLAY_COLUMNS cote serveur). */
function medicationDisplayFields(med: Json): Json {
    return {
        medication_name: med.name, medication_dosage: med.dosage ?? null, dosage: med.dosage ?? null,
        form: med.form ?? null, photo_url: med.photo_url ?? null, instructions: med.instructions ?? null,
        with_food: med.with_food ?? null, reason: med.reason ?? null, appearance: med.appearance ?? null,
        prn: Boolean(med.prn),
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
            if (med.active === false || med.prn) continue;
            if (med.start_date && dateStr < med.start_date) continue;
            if (med.end_date && dateStr > med.end_date) continue;
            for (const sch of (med.schedules as Json[]) || []) {
                if (Array.isArray(sch.days_of_week) && !sch.days_of_week.includes(dow)) continue;
                out.push(buildIntake(c, med, sch, dateStr));
            }
        }
    }
    // Prises ponctuelles ("si besoin") de la periode
    const lastDay = isoDate(new Date(Math.min(to.getTime(), from.getTime() + (maxDays - 1) * 86400000)));
    for (const prn of c.prnIntakes || []) {
        const day = String(prn.due_at).slice(0, 10);
        if (day < fromStr || day > lastDay) continue;
        const med = c.medications.find((m) => m.id === prn.medication_id);
        if (!med) continue;
        out.push({ ...prn, ...medicationDisplayFields(med), schedule_label: null });
    }
    out.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
    return out;
}

/** Note une prise ponctuelle d'un medicament "si besoin" (statut pris, maintenant). */
function logPrnIntake(c: CircleData, medId: string, source: string): Json | null {
    const med = c.medications.find((m) => m.id === medId);
    if (!med) return null;
    const entryId = uid();
    c.journal.unshift({
        id: entryId, circle_id: c.id, author_user_id: store.user.id, caregiver_link_id: null,
        author_name: store.user.name, type: 'medication',
        content: med.dosage ? `${med.name} ${med.dosage}` : med.name,
        data: { medication_id: med.id, status: 'taken', source },
        occurred_at: naiveNow(), created_at: naiveNow(), photos: [],
    });
    const intake: Json = {
        id: `prn-${uid()}`, circle_id: c.id, medication_id: med.id, schedule_id: null,
        due_at: naiveNow(), status: 'taken', confirmed_at: naiveNow(), confirmed_source: source,
        quantity: 1, unit: null, journal_entry_id: entryId,
    };
    c.prnIntakes.push(intake);
    return { ...intake, ...medicationDisplayFields(med), schedule_label: null };
}

function setIntakeStatus(c: CircleData, intakeId: string, status: string, source = 'caregiver'): Json | null {
    // Prise ponctuelle : on change le statut en place.
    if (intakeId.startsWith('prn-')) {
        const prn = (c.prnIntakes || []).find((p) => p.id === intakeId);
        if (!prn) return null;
        if (prn.journal_entry_id) removeFrom(c.journal, prn.journal_entry_id);
        prn.status = status;
        prn.confirmed_at = status === 'pending' ? null : naiveNow();
        prn.confirmed_source = status === 'pending' ? null : source;
        prn.journal_entry_id = null;
        const med = c.medications.find((m) => m.id === prn.medication_id);
        return med ? { ...prn, ...medicationDisplayFields(med), schedule_label: null } : prn;
    }

    const [, medId, schId, dateStr] = intakeId.split('_');
    const med = c.medications.find((m) => m.id === medId);
    const sch = med ? ((med.schedules as Json[]) || []).find((s) => s.id === schId) : undefined;
    if (!med || !sch || !dateStr) return null;

    const previous = (c.intakeOverrides as Json)[intakeId];
    if (previous && previous.journal_entry_id) {
        removeFrom(c.journal, previous.journal_entry_id);
    }

    if (status === 'pending') {
        (c.intakeOverrides as Json)[intakeId] = { status: 'pending', confirmed_at: null, confirmed_source: null, journal_entry_id: null };
        return buildIntake(c, med, sch, dateStr);
    }

    const entryId = uid();
    c.journal.unshift({
        id: entryId, circle_id: c.id, author_user_id: store.user.id, caregiver_link_id: null,
        author_name: source === 'kiosk' || source === 'phone' ? (c.recipient?.first_name || store.user.name) : store.user.name, type: 'medication',
        content: med.dosage ? `${med.name} ${med.dosage}` : med.name,
        data: { medication_id: med.id, intake_id: intakeId, status, source },
        occurred_at: naiveNow(), created_at: naiveNow(), photos: [],
    });
    (c.intakeOverrides as Json)[intakeId] = { status, confirmed_at: naiveNow(), confirmed_source: source, journal_entry_id: entryId };
    return buildIntake(c, med, sch, dateStr);
}

/** Vue patient : uniquement ce qui est du maintenant (meme regle que server/src/lib/intakes.ts). */
function splitForPatient(intakes: Json[], now = new Date()): Json {
    const view: Json = { due_now: [], done: [], missed: [], upcoming_count: 0, next_due_at: null, taken_count: 0, total: intakes.length };
    const nowMs = now.getTime();
    for (const intake of intakes) {
        const dueMs = new Date(String(intake.due_at)).getTime();
        if (intake.status === 'taken' || intake.status === 'skipped') {
            view.done.push(intake);
            if (intake.status === 'taken') view.taken_count += 1;
        } else if (intake.status === 'missed' || dueMs < nowMs - 4 * 3600 * 1000) {
            view.missed.push(intake);
        } else if (dueMs <= nowMs + 30 * 60 * 1000) {
            view.due_now.push(intake);
        } else {
            view.upcoming_count += 1;
            if (!view.next_due_at || String(intake.due_at) < String(view.next_due_at)) view.next_due_at = intake.due_at;
        }
    }
    return view;
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
        unread_messages_count: unreadMessages(c).total,
        attention: attention(c),
    };
}

// Messages non lus : posterieurs a la derniere lecture du fil et ecrits par un autre.
function unreadMessages(c: CircleData): Json {
    const me = store.user.id;
    const circleRead = c.messageReads.circle ?? '';
    const circle = c.messages.filter((m) => m.channel === 'circle' && m.author_user_id !== me && String(m.created_at) > circleRead).length;
    const dms: Json[] = [];
    for (const m of c.messages) {
        if (m.channel !== 'dm' || m.recipient_user_id !== me) continue;
        const peer = String(m.author_user_id);
        if (String(m.created_at) <= (c.messageReads[`dm:${peer}`] ?? '')) continue;
        const row = dms.find((d) => d.user_id === peer);
        if (row) row.count += 1;
        else dms.push({ user_id: peer, count: 1 });
    }
    return { total: circle + dms.reduce((sum, d) => sum + Number(d.count), 0), circle, dms };
}

// Une mesure sort-elle de la plage fixee ? Meme regle que le serveur.
function vitalOutOfRange(c: CircleData, v: Json): boolean {
    const th = c.vitalThresholds.find((t) => t.type === v.type);
    if (!th) return false;
    const value = Number(v.value);
    const value2 = v.value2 === null || v.value2 === undefined ? null : Number(v.value2);
    if (th.min_value !== null && th.min_value !== undefined && value < Number(th.min_value)) return true;
    if (th.max_value !== null && th.max_value !== undefined && value > Number(th.max_value)) return true;
    if (value2 !== null) {
        if (th.min_value2 !== null && th.min_value2 !== undefined && value2 < Number(th.min_value2)) return true;
        if (th.max_value2 !== null && th.max_value2 !== undefined && value2 > Number(th.max_value2)) return true;
    }
    return false;
}

// "A traiter" : meme logique que server/src/lib/attention.ts, sur la graine.
function attention(c: CircleData): Json[] {
    const now = new Date();
    const today = isoDate(now);
    const items: Json[] = [];
    const dayAgo = now.getTime() - 24 * 3600 * 1000;
    const incidents = journalDesc(c).filter((e) => e.type === 'incident' && new Date(String(e.occurred_at)).getTime() >= dayAgo);
    if (incidents.length) items.push({ kind: 'help', severity: 'urgent', count: incidents.length, href: '/journal', details: incidents.slice(0, 5).map((e) => ({ id: e.id, label: String(e.content).slice(0, 140), when: e.occurred_at, extra: e.author_name })) });
    const rule = c.presenceRule;
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (rule && rule.enabled && String(rule.no_activity_before).slice(0, 5) <= hhmm && !c.presenceSignals.some((sig) => String(sig.occurred_at).slice(0, 10) === today)) {
        items.push({ kind: 'presence', severity: 'urgent', count: 1, href: '/', details: [], time: String(rule.no_activity_before).slice(0, 5) });
    }
    if (c.role !== 'neighbor') {
        const weekAgo = new Date(now.getTime() - 7 * 86400000).getTime();
        const outOfRange = c.vitals.filter((v) => new Date(String(v.measured_at)).getTime() >= weekAgo && vitalOutOfRange(c, v));
        if (outOfRange.length) items.push({ kind: 'vitals_out_of_range', severity: 'warn', count: outOfRange.length, href: '/health', details: outOfRange.slice(0, 5).map((v) => ({ id: v.id, label: v.type, when: v.measured_at, extra: v.value2 !== null && v.value2 !== undefined ? `${v.value}/${v.value2}` : String(v.value) })) });
        const low = c.medications.filter((m) => m.active !== false && m.stock_quantity !== null && m.stock_quantity !== undefined && m.stock_alert_threshold !== null && m.stock_alert_threshold !== undefined && Number(m.stock_quantity) <= Number(m.stock_alert_threshold));
        if (low.length) items.push({ kind: 'medication_stock', severity: 'warn', count: low.length, href: '/medications', details: low.slice(0, 5).map((m) => ({ id: m.id, label: m.name, when: null, extra: String(m.stock_quantity) })) });
        const missed = intakesForRange(c, today, today).filter((i) => i.status === 'missed');
        if (missed.length) items.push({ kind: 'missed_intakes', severity: 'urgent', count: missed.length, href: '/medications', details: missed.slice(0, 5).map((i) => ({ id: i.id, label: i.medication_name, when: i.due_at })) });
        const presc = c.prescriptions.filter((p) => p.renewal_date && new Date(`${String(p.renewal_date).slice(0, 10)}T12:00:00`).getTime() <= now.getTime() + (Number(p.reminder_days) || 7) * 86400000);
        if (presc.length) items.push({ kind: 'prescriptions', severity: 'warn', count: presc.length, href: '/medications', details: presc.slice(0, 5).map((p) => ({ id: p.id, label: p.title, when: String(p.renewal_date).slice(0, 10) })) });
    }
    const overdue = c.tasks.filter((t) => !t.is_completed && t.due_date && new Date(String(t.due_date)).getTime() < now.getTime());
    if (overdue.length) items.push({ kind: 'tasks_overdue', severity: 'warn', count: overdue.length, href: '/tasks', details: overdue.slice(0, 5).map((t) => ({ id: t.id, label: t.title, when: t.due_date })) });
    const active = c.visits.filter((v) => !v.checked_out_at && String(v.checked_in_at).slice(0, 10) === today);
    const openHelp = c.helpRequests.filter((h) => !h.acknowledged_at);
    if (incidents.length && openHelp.length) items[0].open_help = openHelp.map((h) => ({ id: h.id, created_at: h.created_at }));
    if (active.length) items.push({ kind: 'visitor_present', severity: 'info', count: active.length, href: '/visitors', details: active.map((v) => ({ id: v.id, label: v.visitor_name, when: v.checked_in_at, extra: v.visitor_type })), name: active[0].visitor_name });
    const soon = now.getTime() + 2 * 3600 * 1000;
    const upcoming = expandEvents(c, startOfDay(now), new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59))
        .filter((e) => { const at = new Date(String(e.start_time)).getTime(); return at >= now.getTime() && at <= soon; });
    if (upcoming.length) items.push({ kind: 'appointments', severity: 'info', count: upcoming.length, href: '/calendar', details: upcoming.slice(0, 5).map((e) => ({ id: e.id, label: e.title, when: e.start_time, extra: e.location ?? null })) });
    return items;
}

function carePlan(c: CircleData): Json {
    const now = new Date();
    const from = startOfDay(now);
    const to = new Date(from.getTime() + 7 * 86400000 - 1000);
    const occurrences = expandEvents(c, from, to);
    const membersById = new Map(c.members.map((m) => [m.id as string, m]));
    const days: Json[] = [];
    for (let i = 0; i < 7; i += 1) {
        const date = isoDate(new Date(from.getTime() + i * 86400000));
        days.push({
            date,
            items: occurrences.filter((e) => String(e.start_time).slice(0, 10) === date).map((e) => ({
                id: e.id, title: e.title, category: e.category, location: e.location ?? null, start_time: e.start_time, end_time: e.end_time ?? null,
                members: ((e.member_ids as string[]) || []).map((id) => membersById.get(id)?.name).filter(Boolean), recurring: Boolean(e.rrule),
            })),
        });
    }
    return {
        sections: c.carePlan?.sections ?? {}, updated_at: c.carePlan?.updated_at ?? null, updated_by_name: c.carePlan?.updated_by_name ?? null,
        medications: c.role === 'neighbor' ? null : c.medications.filter((m) => m.active !== false).map((m) => ({
            id: m.id, name: m.name, dosage: m.dosage ?? null, form: m.form ?? null, instructions: m.instructions ?? null, prn: Boolean(m.prn),
            with_food: m.with_food ?? null, reason: m.reason ?? null, appearance: m.appearance ?? null,
            schedules: ((m.schedules as Json[]) || []).map((s) => ({ time: s.time_of_day, label: s.label ?? null, days_of_week: s.days_of_week, quantity: s.quantity, unit: s.unit ?? null })),
        })),
        professionals: c.contacts.filter((k) => ['doctor', 'nurse', 'aide', 'physio', 'pharmacy'].includes(String(k.category)))
            .map((k) => ({ id: k.id, name: k.name, category: k.category, organization: k.organization ?? null, phone: k.phone ?? null, phone2: k.phone2 ?? null, email: k.email ?? null })),
        week: { from: isoDate(from), to: isoDate(to), days },
    };
}

function householdDashboard(active: CircleData): Json {
    const householdId = active.household_id ?? null;
    if (!householdId) return { circles: [] };
    const now = new Date();
    const dayStart = startOfDay(now);
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const today = isoDate(now);

    const circles = store.circles
        .filter((c) => c.household_id === householdId)
        .map((c) => {
            const includeHealth = c.role !== 'neighbor';
            const events = expandEvents(c, dayStart, dayEnd);
            const upcoming = events.filter((e) => new Date(String(e.start_time)).getTime() >= now.getTime());
            const next = upcoming[0] ?? null;
            const intakes = includeHealth ? intakesForRange(c, today, today) : [];
            const last = journalDesc(c)[0] ?? null;
            return {
                circle_id: c.id,
                recipient_first_name: c.recipient ? c.recipient.first_name : null,
                recipient_photo_url: c.recipient ? c.recipient.photo_url : null,
                role: c.role,
                today_event_count: events.length,
                next_event: next ? { title: next.title, start_time: next.start_time } : null,
                meds: includeHealth
                    ? { taken: intakes.filter((i) => i.status === 'taken').length, total: intakes.length }
                    : null,
                last_journal: last ? { author_name: last.author_name, occurred_at: last.occurred_at } : null,
            };
        });
    return { circles };
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
        intakes_today: intakesForRange(c, isoDate(now), isoDate(now)),
        medications: splitForPatient(intakesForRange(c, isoDate(now), isoDate(now)), now),
        contacts_key: c.contacts
            .filter((k) => ['doctor', 'nurse', 'pharmacy', 'aide', 'physio'].includes(String(k.category)))
            .slice(0, 8)
            .map((k) => ({ id: k.id, name: k.name, category: k.category, phone: k.phone ?? null, organization: k.organization ?? null })),
        pin_required: demoKiosk.pinSet,
        device: null,
        members: c.members.map((m) => ({ id: m.id, name: m.name, avatar_url: m.avatar_url ?? null, role: m.role })),
        visits_today: c.visits.filter((v) => String(v.checked_in_at).slice(0, 10) === isoDate(now)),
        active_visit: c.visits.find((v) => !v.checked_out_at) ?? null,
        photos_enabled: false,
        heatwave: (() => {
            const h = heatwaveOf(c);
            return h.enabled && h.active ? { active: true, level: h.level } : null;
        })(),
        companion_enabled: true,
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
    // Mot de passe oublie : la demo n'envoie rien, elle montre le parcours
    // "sans e-mail" (remise du lien par un administrateur du cercle).
    if (path === '/api/auth/forgot-password') return ok({ delivery: 'admin' });
    if (path === '/api/auth/reset-password') return ok({});
    if (seg[1] === 'auth' && seg[2] === 'reset-password' && seg[3]) return ok({ valid: true, name: store.user.name });
    if (path === '/api/auth/password-resets') return ok([]);
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
        // Foyer (couple): lier au cercle existant et reprendre son equipe.
        const linkId = typeof body.link_circle_id === 'string' ? body.link_circle_id : '';
        const linkTarget = linkId ? circleById(linkId) : undefined;
        if (linkTarget) {
            const household = (linkTarget.household_id as string | null) ?? uid();
            linkTarget.household_id = household;
            created.household_id = household;
            if (body.copy_members === true) {
                for (const m of linkTarget.members) {
                    if (m.user_id === store.user.id) continue;
                    created.members.push({ ...m, id: uid(), circle_id: created.id, created_at: naiveNow() });
                }
            }
        }
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
            if (seg[3] === 'link' && seg.length === 4) {
                if (method === 'POST') {
                    const other = circleById(typeof body.target_circle_id === 'string' ? body.target_circle_id : '');
                    if (other) {
                        const household = (target.household_id as string | null)
                            ?? (other.household_id as string | null) ?? uid();
                        target.household_id = household;
                        other.household_id = household;
                        return ok({ household_id: household });
                    }
                    return ok({});
                }
                if (method === 'DELETE') {
                    const household = target.household_id as string | null;
                    target.household_id = null;
                    if (household) {
                        const remaining = store.circles.filter((x) => x.household_id === household);
                        if (remaining.length === 1) remaining[0].household_id = null;
                    }
                    return ok({});
                }
            }
            if (seg[3] === 'household' && seg.length === 4 && method === 'PUT') {
                const household = target.household_id as string | null;
                if (!household) return ok({ household_name: null });
                const nm = typeof body.name === 'string' ? body.name.trim() : '';
                if (nm) demoHouseholdNames[household] = nm;
                else delete demoHouseholdNames[household];
                return ok({ household_name: nm || null });
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
            prn: Boolean(body.prn), with_food: body.with_food || null, reason: body.reason || null, appearance: body.appearance || null,
            schedules: (Array.isArray(body.schedules) ? body.schedules : []).map((s: Json) => ({
                id: uid(), medication_id: medId, time_of_day: s.time_of_day,
                days_of_week: Array.isArray(s.days_of_week) && s.days_of_week.length > 0 ? s.days_of_week : [1, 2, 3, 4, 5, 6, 7],
                label: s.label || null, quantity: Number(s.quantity) > 0 ? Number(s.quantity) : 1, unit: s.unit || null,
            })),
        };
        c.medications.push(med);
        return ok(med);
    }
    // Prise ponctuelle d'un medicament "si besoin"
    if (seg[1] === 'medications' && seg.length === 4 && seg[3] === 'intakes' && method === 'POST') {
        const created = logPrnIntake(c, seg[2], 'caregiver');
        if (!created) throw new Error('Medication not found');
        return ok(created);
    }
    if (seg[1] === 'medications' && seg.length === 3) {
        if (method === 'PUT') {
            const patch: Json = { ...body };
            if (Array.isArray(body.schedules)) {
                patch.schedules = body.schedules.map((s: Json) => ({
                    id: s.id || uid(), medication_id: seg[2], time_of_day: s.time_of_day,
                    days_of_week: Array.isArray(s.days_of_week) && s.days_of_week.length > 0 ? s.days_of_week : [1, 2, 3, 4, 5, 6, 7],
                    label: s.label || null, quantity: Number(s.quantity) > 0 ? Number(s.quantity) : 1, unit: s.unit || null,
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
    if (path === '/api/dashboard/household') return ok(householdDashboard(c));

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
    if (path === '/api/emergency/payload' && method === 'GET') {
        return ok({
            recipient: c.recipient ?? null,
            medications: c.medications
                .filter((m) => m.active !== false)
                .map((m) => ({
                    name: m.name, dosage: m.dosage, form: m.form,
                    schedules: ((m.schedules as Json[]) || []).map((s) => ({ time: s.time_of_day, label: s.label })),
                })),
            contacts: c.contacts.filter((ct) => ct.phone).slice(0, 8),
            extra_notes: c.emergencySheet.extra_notes,
        });
    }
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
            content: {
                summary: `Synthèse de la semaine pour ${recipientName} (générée à la demande dans la démo). Rythme régulier : passages de l'auxiliaire le matin, visites de la famille en fin de journée. Moral stable et appétit correct.`,
                stats: { visits: 9, journal_entries: 18 },
                attention_points: [
                    'Une prise de traitement oubliée dans la semaine.',
                    'Pensez au prochain renouvellement d\'ordonnance.',
                ],
                weak_signals: [],
            },
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

    // ── Canicule / fortes chaleurs ───────────────────────────────────────────
    if (path === '/api/heatwave' && method === 'GET') return ok(heatwaveOf(c));
    if (path === '/api/heatwave' && method === 'PUT') {
        const current = heatwaveOf(c);
        const times = Array.isArray(body.reminder_times)
            ? (body.reminder_times as unknown[]).filter((x): x is string => typeof x === 'string')
            : current.reminder_times;
        c.heatwave = { ...current, enabled: body.enabled === true, reminder_times: times };
        return ok(heatwaveOf(c));
    }
    if (path === '/api/heatwave/toggle' && method === 'POST') {
        const current = heatwaveOf(c);
        const active = body.active === true;
        c.heatwave = {
            ...current,
            enabled: active ? true : current.enabled,
            active,
            level: body.level === 'red' ? 'red' : 'orange',
            activated_at: active ? naiveNow() : null,
        };
        return ok(heatwaveOf(c));
    }

    // ── Kiosk ────────────────────────────────────────────────────────────────
    if (path === '/api/kiosk/today') return ok(kioskToday(c));
    if (path === '/api/kiosk/care-plan') return ok({ sections: Object.fromEntries(Object.entries((c.carePlan?.sections ?? {}) as Record<string, string>).filter(([, v]) => v)), updated_at: c.carePlan?.updated_at ?? null });
    // Plan de soins : consignes (texte) + routine medicamenteuse + professionnels + semaine
    // Escalade : regles du cercle et demandes d aide sans prise en charge
    // Exceptions d'occurrence d'un evenement recurrent
    if (seg[1] === 'events' && seg[3] === 'occurrences' && seg.length === 5) {
        const ev = c.events.find((e) => e.id === seg[2]);
        if (!ev || !ev.rrule) throw new Error('Not found');
        const day = seg[4];
        const list: Json[] = Array.isArray(ev.exceptions) ? ev.exceptions : [];
        if (method === 'PUT') {
            const next = list.filter((e) => e.date !== day);
            if (body.action === 'skip') next.push({ date: day, action: 'skip' });
            else if (body.action === 'move' && body.start_time) next.push({ date: day, action: 'move', start_time: body.start_time, end_time: body.end_time ?? null });
            else throw new Error('action must be skip or move');
            ev.exceptions = next.sort((a, b) => String(a.date).localeCompare(String(b.date)));
            return ok(ev);
        }
        if (method === 'DELETE') {
            const next = list.filter((e) => e.date !== day);
            if (next.length === list.length) throw new Error('Not found');
            ev.exceptions = next;
            return ok(ev);
        }
    }
    // Stock d'un medicament
    if (seg[1] === 'medications' && seg[3] === 'stock' && method === 'PUT') {
        const med = c.medications.find((m) => m.id === seg[2]);
        if (!med) throw new Error('Not found');
        for (const key of ['stock_quantity', 'stock_alert_threshold']) {
            if (!(key in body)) continue;
            const raw = body[key];
            if (raw === null || raw === '') { med[key] = null; continue; }
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('Invalid stock');
            med[key] = Math.round(n * 100) / 100;
        }
        med.stock_updated_at = naiveNow();
        return ok(med);
    }
    // Seuils sur les constantes
    if (path === '/api/vitals/thresholds' && method === 'GET') return ok(c.vitalThresholds);
    if (path === '/api/vitals/thresholds' && method === 'PUT') {
        const type = String(body.type || '');
        if (!['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'].includes(type)) throw new Error('Unknown vital type');
        const bounds = ['min_value', 'max_value', 'min_value2', 'max_value2'].map((k) => (body[k] === null || body[k] === '' || body[k] === undefined ? null : Number(body[k])));
        if (bounds.some((b) => b !== null && !Number.isFinite(b))) throw new Error('Invalid threshold');
        const [minV, maxV, minV2, maxV2] = bounds;
        if ((minV !== null && maxV !== null && minV >= maxV) || (minV2 !== null && maxV2 !== null && minV2 >= maxV2)) throw new Error('Invalid threshold');
        const existing = c.vitalThresholds.findIndex((t) => t.type === type);
        if (existing >= 0) c.vitalThresholds.splice(existing, 1);
        if (bounds.every((b) => b === null)) return ok(null);
        const row = { type, min_value: minV, max_value: maxV, min_value2: minV2, max_value2: maxV2 };
        c.vitalThresholds.push(row);
        return ok(row);
    }
    // Messages lus et non lus
    if (path === '/api/messages/unread' && method === 'GET') return ok(unreadMessages(c));
    if (path === '/api/messages/read' && method === 'POST') {
        const key = body.channel === 'dm' && body.peer_user_id ? `dm:${body.peer_user_id}` : 'circle';
        c.messageReads[key] = naiveNow();
        return ok(unreadMessages(c));
    }
    if (path === '/api/escalation/rules' && method === 'GET') return ok({ rules: c.escalation });
    if (path === '/api/escalation/rules' && method === 'PUT') {
        const r = c.escalation as Record<string, unknown>;
        if (body.enabled !== undefined) r.enabled = body.enabled === true;
        for (const k of ['med_patient_min', 'med_primary_min', 'med_secondary_min', 'help_ack_min']) {
            if (body[k] === undefined) continue;
            const n = Number(body[k]);
            if (!Number.isInteger(n) || n < 0 || n > 1440) throw new Error('Invalid minutes');
            r[k] = n;
        }
        for (const k of ['primary_member_ids', 'secondary_member_ids']) if (Array.isArray(body[k])) r[k] = body[k];
        return ok({ rules: c.escalation });
    }
    if (path === '/api/escalation/help' && method === 'GET') return ok(c.helpRequests.filter((h) => !h.acknowledged_at));
    if (seg[1] === 'escalation' && seg[2] === 'help' && seg[4] === 'ack' && method === 'POST') {
        const req = c.helpRequests.find((h) => h.id === seg[3] && !h.acknowledged_at);
        if (!req) throw new Error('Not found');
        req.acknowledged_at = naiveNow();
        return ok(req);
    }
    if (path === '/api/care-plan' && method === 'GET') return ok(carePlan(c));
    if (path === '/api/care-plan' && method === 'PUT') {
        const next: Record<string, string> = { ...((c.carePlan?.sections ?? {}) as Record<string, string>) };
        for (const [k, v] of Object.entries((body.sections ?? {}) as Record<string, unknown>)) if (typeof v === 'string') next[k] = v.trim().slice(0, 4000);
        c.carePlan = { sections: next, updated_at: naiveNow(), updated_by_name: store.user.name };
        return ok({ sections: next, updated_at: c.carePlan.updated_at, updated_by_name: store.user.name });
    }
    // Visiteurs : arrivee, note de passage, depart (ecran patient) et liste (aidants)
    if (path === '/api/kiosk/visits/check-in' && method === 'POST') {
        const visit: Json = {
            id: uid(), circle_id: c.id, visitor_type: body.visitor_type || 'other', visitor_name: String(body.visitor_name || '').trim() || 'Visiteur',
            member_id: body.member_id || null, device_id: null, checked_in_at: naiveNow(), checked_out_at: null, note: null, journal_entry_id: null, created_at: naiveNow(),
        };
        const entryId = uid();
        c.journal.unshift({ id: entryId, circle_id: c.id, author_user_id: null, caregiver_link_id: null, author_name: visit.visitor_name, type: 'visit', content: `${visit.visitor_name} est arrivé(e) chez ${c.recipient?.first_name ?? ''}`.trim(), data: { source: 'kiosk_visitor', visit_id: visit.id }, occurred_at: naiveNow(), created_at: naiveNow(), photos: [] });
        visit.journal_entry_id = entryId;
        c.visits.unshift(visit);
        return ok(visit);
    }
    if (seg[1] === 'kiosk' && seg[2] === 'visits' && seg.length === 5 && method === 'POST') {
        const visit = c.visits.find((v) => v.id === seg[3]);
        if (!visit) throw new Error('Not found');
        if (seg[4] === 'check-out') { visit.checked_out_at = naiveNow(); return ok(visit); }
        if (seg[4] === 'note') {
            const content = String(body.content || '').trim();
            visit.note = visit.note ? `${visit.note}\n${content}` : content;
            c.journal.unshift({ id: uid(), circle_id: c.id, author_user_id: null, caregiver_link_id: null, author_name: visit.visitor_name, type: 'visit', content, data: { source: 'kiosk_visitor', visit_id: visit.id, note: true }, occurred_at: naiveNow(), created_at: naiveNow(), photos: [] });
            return ok(visit);
        }
    }
    if (path === '/api/visits' && method === 'GET') {
        const from = q.from ? `${q.from}T00:00:00` : '0000';
        const to = q.to ? `${q.to}T23:59:59` : '9999';
        return ok(c.visits.filter((v) => String(v.checked_in_at) >= from && String(v.checked_in_at) <= to).sort((a, b) => String(b.checked_in_at).localeCompare(String(a.checked_in_at))));
    }
    if (seg[1] === 'visits' && seg.length === 3 && method === 'DELETE') { removeFrom(c.visits, seg[2]); return ok({}); }
    // Appareils patient, appairage et code aidant (tout en memoire pour la demo)
    if (path === '/api/kiosk/devices' && method === 'GET') return ok({ devices: demoKiosk.devices, pin_configured: demoKiosk.pinSet });
    if (path === '/api/kiosk/devices/pairing' && method === 'POST') {
        const kind = body.kind === 'phone' ? 'phone' : 'kiosk';
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : (kind === 'phone' ? 'Téléphone' : 'Tablette');
        // Le code de demo est accepte tel quel par /api/kiosk/pair : l'appareil apparait dans la liste.
        const expires = new Date(Date.now() + 15 * 60000);
        demoKiosk.devices.push({ id: uid(), name, kind, last_seen_at: null, created_at: naiveNow() });
        return ok({ code: 'DEMO24', kind, name, expires_at: toLocalISO(expires) });
    }
    if (seg[1] === 'kiosk' && seg[2] === 'devices' && seg.length === 4 && method === 'DELETE') {
        removeFrom(demoKiosk.devices, seg[3]);
        return ok({});
    }
    if (path === '/api/kiosk/pin' && method === 'PUT') {
        if (!/^\d{4,8}$/.test(String(body.pin ?? ''))) throw new Error('PIN_INVALID');
        demoKiosk.pin = String(body.pin); demoKiosk.pinSet = true;
        return ok({ pin_configured: true });
    }
    if (path === '/api/kiosk/pin' && method === 'DELETE') { demoKiosk.pin = ''; demoKiosk.pinSet = false; return ok({ pin_configured: false }); }
    if (path === '/api/kiosk/pin/verify' && method === 'POST') {
        return ok({ ok: !demoKiosk.pinSet || String(body.pin ?? '') === demoKiosk.pin, configured: demoKiosk.pinSet });
    }
    if (path === '/api/kiosk/pair' && method === 'POST') {
        const device = { id: uid(), name: 'Tablette (démo)', kind: 'kiosk', settings: {} };
        return ok({ token: 'demo-kiosk-token', circle_id: c.id, device, recipient_first_name: c.recipient?.first_name ?? null });
    }
    if (path === '/api/kiosk/device/settings' && method === 'PUT') return ok({ id: 'demo', name: 'Tablette (démo)', kind: 'kiosk', settings: body });
    if (path === '/api/kiosk/device/unpair' && method === 'POST') return ok({});
    // "J'ai tout pris" : toutes les prises listees passent a "pris", source kiosk ou telephone.
    if (path === '/api/kiosk/intakes/confirm' && method === 'POST') {
        const ids: string[] = Array.isArray(body.intake_ids) ? body.intake_ids : [];
        const source = body.source === 'phone' ? 'phone' : 'kiosk';
        let confirmed = 0;
        for (const id of ids) { if (setIntakeStatus(c, id, 'taken', source)) confirmed++; }
        return ok({ confirmed });
    }
    if (path === '/api/kiosk/status' && method === 'POST') {
        const kind = body.kind === 'help' ? 'help' : body.kind === 'hydration' ? 'hydration' : 'ok';
        const firstName = c.recipient ? c.recipient.first_name : 'Kiosk';
        const content = kind === 'help'
            ? 'J\'ai besoin d\'aide (signal envoyé depuis le kiosk)'
            : kind === 'hydration'
                ? 'A bu de l\'eau (signalé depuis le kiosk)'
                : 'Tout va bien (signal envoyé depuis le kiosk)';
        const entry = {
            id: uid(), circle_id: c.id, author_user_id: null, caregiver_link_id: null,
            author_name: firstName,
            type: kind === 'help' ? 'incident' : kind === 'hydration' ? 'note' : 'mood',
            content,
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
        return ok({ configured: true, enabled: true, provider: 'ollama', base_url: 'http://localhost:11434', model: 'llama3.1', has_api_key: false, companion_enabled: true });
    }
    if (path === '/api/ai/settings' && method === 'PUT') {
        return ok({
            configured: true,
            enabled: body.enabled !== false,
            provider: (body.provider as string) || 'ollama',
            base_url: (body.base_url as string) ?? null,
            model: (body.model as string) || 'llama3.1',
            has_api_key: Boolean(body.api_key),
            companion_enabled: body.companion_enabled === true,
        });
    }
    if (path === '/api/companion/message' && method === 'POST') {
        // Comme le serveur : les questions pratiques sont repondues depuis les
        // donnees du cercle (sans IA), le reste simule un compagnon.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const msgs = Array.isArray(body.messages) ? (body.messages as Array<{ role: string; content: string }>) : [];
        const last = msgs.length > 0 ? String(msgs[msgs.length - 1]?.content || '') : '';
        const lang: CompanionLang = store.user.language === 'en' ? 'en' : 'fr';
        const today = kioskToday(c);
        const facts: CompanionFactsInput = {
            recipientFirstName: c.recipient?.first_name ?? '',
            medications: today.medications,
            events_today: today.events_today,
            visits_today: today.visits_today,
            contacts_key: today.contacts_key,
            heatwave: today.heatwave,
        };
        const intent = detectIntent(last);
        if (intent) {
            const hint = intent !== 'help' && hasDistressSignal(last) ? distressHint(lang) : '';
            return ok({ reply: answerIntent(intent, facts, lang) + hint, flagged: intent === 'help', source: 'facts', intent });
        }
        const reply = lang === 'en'
            ? 'That is kind of you to tell me. What memory does it bring back?'
            : "C'est gentil de me raconter ça. Et qu'est-ce que ça t'évoque comme souvenir ?";
        return ok({ reply, flagged: false, source: 'ai', intent: null });
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
