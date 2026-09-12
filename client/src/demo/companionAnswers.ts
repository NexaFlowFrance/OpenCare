/**
 * "Demandez-moi" : reponses ancrees sur les donnees du cercle, sans IA.
 *
 * Detection d'intention par mots-cles (francais et anglais) et phrase de
 * reponse construite a partir de l'instantane du jour : medicaments a prendre
 * maintenant, visites, rendez-vous, date et heure, personnes a appeler,
 * canicule. Le francais tutoie, comme le reste de l'ecran patient.
 *
 * Module sans dependance. Une copie identique sert la demo statique
 * (client/src/demo/companionAnswers.ts) : garder les deux fichiers alignes.
 */

export type CompanionLang = 'fr' | 'en';
export type CompanionIntent = 'help' | 'medications' | 'visitors' | 'appointments' | 'datetime' | 'contacts' | 'weather';

export interface FactsIntake {
    medication_name: string;
    dosage?: string | null;
    quantity?: number | string | null;
    unit?: string | null;
    due_at: string;
}
export interface FactsEvent {
    title: string;
    category: string;
    location?: string | null;
    start_time: string;
    members?: Array<{ name: string }>;
}
export interface FactsVisit {
    visitor_type: string;
    visitor_name: string;
    checked_in_at: string;
    checked_out_at: string | null;
}
export interface FactsContact {
    name: string;
    category: string;
    phone?: string | null;
    organization?: string | null;
}
export interface CompanionFactsInput {
    recipientFirstName: string;
    medications: { due_now: FactsIntake[]; done: FactsIntake[]; next_due_at: string | null };
    events_today: FactsEvent[];
    visits_today: FactsVisit[];
    contacts_key: FactsContact[];
    heatwave: { active: boolean; level?: string } | null;
}

/** Minuscules, sans accents ni apostrophes : "Qu'est-ce que je dois prendre ?" -> "qu est-ce que je dois prendre ?" */
export const normalizeText = (text: string): string =>
    text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, ' ').replace(/\s+/g, ' ').trim();

// L'ordre compte : la demande d'aide passe avant tout le reste.
const PATTERNS: Array<[CompanionIntent, RegExp]> = [
    ['help', /\b(au secours|besoin d aide|aidez(-| )moi|aide(-| )moi|urgence|appelle (ma|la) famille|previens (ma|la) famille|help me|i need help|emergency|call (my|the) family)\b/],
    ['medications', /\b(medicaments?|cachets?|comprimes?|gelules?|pilules?|pilulier|traitement|dois(-| )je prendre|dois prendre|faut prendre|quoi prendre|a prendre|prendre (mes|ce|quoi|quelque chose)|prises?|medications?|medicines?|pills?|tablets?|(should|do|must) i take|what (do|should) i take|my treatment|next dose)\b/],
    ['visitors', /\b(qui vient|qui passe|qui va venir|qui doit venir|qui est venu|qui est la|qui est passe|qui est chez moi|visites?|visiteurs?|infirmier|infirmiere|aide a domicile|aide(-| )menagere|who is coming|who comes|who came|who is here|who visited|who is visiting|visitors?|visits?|the nurse|home aide|home help)\b/],
    ['appointments', /\b(rendez(-| )vous|rdv|docteur|medecin|dentiste|kine|kinesitherapeute|specialiste|hopital|consultation|agenda|programme|prevu aujourd hui|appointments?|doctor|dentist|physio|hospital|schedule|what is planned|planned today)\b/],
    ['datetime', /\b(quel jour|quelle date|quelle heure|on est quel|nous sommes quel|quel mois|quelle annee|le combien|what day|what date|what time|what is the date|what month|what year|the date today)\b/],
    ['contacts', /\b(appeler|telephoner|numero|telephone|joindre|pharmacie|(who|whom) (can|should|do) i call|phone number|call the|call my|pharmacy|how do i reach)\b/],
    ['weather', /\b(meteo|temps qu il fait|quel temps|fait chaud|fait froid|canicule|chaleur|il pleut|pluie|weather|is it hot|is it cold|heatwave|raining|rain)\b/],
];

const DISTRESS = /\b(j ai mal|ca fait mal|douleurs?|je suis tombee?|chute|j ai peur|angoissee?|je pleure|je saigne|vertiges?|malaise|etouffe|respire mal|je me sens mal|pas bien|tres seule?|mourir|it hurts|i m hurt|in pain|i fell|fallen|i m scared|afraid|bleeding|dizzy|faint|can t breathe|i feel sick|not well|want to die|so lonely)\b/;

export function detectIntent(text: string): CompanionIntent | null {
    const norm = normalizeText(text);
    if (!norm) return null;
    for (const [intent, re] of PATTERNS) if (re.test(norm)) return intent;
    return null;
}

/** Signal de detresse par mots-cles : oriente vers l'IA (qui sait escalader) ou ajoute le rappel du bouton rouge. */
export const hasDistressSignal = (text: string): boolean => DISTRESS.test(normalizeText(text));

// ── Mise en forme ──

const firstNameOf = (name: string): string => (name || '').trim().split(/\s+/)[0] || '';

export function fmtTime(iso: string, lang: CompanionLang): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    if (lang === 'fr') return d.getMinutes() === 0 ? `${h} h` : `${h} h ${m}`;
    return `${h}:${m}`;
}

const fmtDate = (now: Date, lang: CompanionLang): string =>
    new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);

const UNIT_LABELS: Record<CompanionLang, Record<string, [string, string]>> = {
    fr: { tablet: ['comprimé', 'comprimés'], capsule: ['gélule', 'gélules'], ml: ['ml', 'ml'], drop: ['goutte', 'gouttes'], sachet: ['sachet', 'sachets'], patch: ['patch', 'patchs'], injection: ['injection', 'injections'], puff: ['bouffée', 'bouffées'], application: ['application', 'applications'], dose: ['dose', 'doses'] },
    en: { tablet: ['tablet', 'tablets'], capsule: ['capsule', 'capsules'], ml: ['ml', 'ml'], drop: ['drop', 'drops'], sachet: ['sachet', 'sachets'], patch: ['patch', 'patches'], injection: ['injection', 'injections'], puff: ['puff', 'puffs'], application: ['application', 'applications'], dose: ['dose', 'doses'] },
};

const VISITOR_LABELS: Record<CompanionLang, Record<string, string>> = {
    fr: { family: 'famille', friend: 'ami ou voisin', caregiver: 'aide à domicile', nurse: 'soins infirmiers', doctor: 'médecin', other: '' },
    en: { family: 'family', friend: 'friend or neighbour', caregiver: 'home aide', nurse: 'nurse', doctor: 'doctor', other: '' },
};

const EVENT_LABELS: Record<CompanionLang, Record<string, string>> = {
    fr: { nurse: "l'infirmier ou l'infirmière", aide: "l'aide à domicile" },
    en: { nurse: 'the nurse', aide: 'the home aide' },
};

const CONTACT_LABELS: Record<CompanionLang, Record<string, string>> = {
    fr: { doctor: 'médecin', nurse: 'soins infirmiers', aide: 'aide à domicile', physio: 'kiné', pharmacy: 'pharmacie' },
    en: { doctor: 'doctor', nurse: 'nurse', aide: 'home aide', physio: 'physio', pharmacy: 'pharmacy' },
};

const joinList = (items: string[], lang: CompanionLang): string => {
    if (items.length <= 1) return items.join('');
    const and = lang === 'fr' ? ' et ' : ' and ';
    return `${items.slice(0, -1).join(', ')}${and}${items[items.length - 1]}`;
};

/** "Metformine, 2 comprimés" (ou le dosage textuel si la quantite manque). */
export function describeIntake(intake: FactsIntake, lang: CompanionLang): string {
    const q = Number(intake.quantity);
    if (!Number.isFinite(q) || q <= 0) return intake.dosage ? `${intake.medication_name} (${intake.dosage})` : intake.medication_name;
    const labels = UNIT_LABELS[lang][intake.unit || ''];
    const qs = Number.isInteger(q) ? String(q) : String(q).replace('.', lang === 'fr' ? ',' : '.');
    const label = labels ? (q > 1 ? labels[1] : labels[0]) : (intake.unit || '');
    return `${intake.medication_name}, ${qs} ${label}`.trim();
}

const eventWho = (ev: FactsEvent, lang: CompanionLang): string => {
    const names = (ev.members || []).map((m) => firstNameOf(m.name)).filter(Boolean);
    if (names.length > 0) return joinList(names, lang);
    return EVENT_LABELS[lang][ev.category] || ev.title;
};

const visitLabel = (v: FactsVisit, lang: CompanionLang): string => {
    const role = VISITOR_LABELS[lang][v.visitor_type] || '';
    return role ? `${firstNameOf(v.visitor_name)} (${role})` : firstNameOf(v.visitor_name);
};

const at = (lang: CompanionLang): string => (lang === 'fr' ? 'à' : 'at');

// ── Reponses ──

function answerMedications(f: CompanionFactsInput, lang: CompanionLang): string {
    const due = f.medications.due_now.map((i) => describeIntake(i, lang));
    if (due.length > 0) {
        return lang === 'fr'
            ? `Maintenant, tu dois prendre : ${joinList(due, lang)}. Appuie sur le bouton vert quand c'est fait.`
            : `Right now you need to take: ${joinList(due, lang)}. Tap the green button when it is done.`;
    }
    const done = f.medications.done.map((i) => i.medication_name);
    const next = f.medications.next_due_at ? fmtTime(f.medications.next_due_at, lang) : '';
    const parts: string[] = [];
    if (lang === 'fr') {
        parts.push("Rien à prendre pour l'instant.");
        if (done.length > 0) parts.push(`Tu as déjà pris ${joinList(done, lang)} aujourd'hui.`);
        parts.push(next ? `Prochaine prise à ${next}.` : "Plus rien à prendre aujourd'hui.");
    } else {
        parts.push('Nothing to take right now.');
        if (done.length > 0) parts.push(`You already took ${joinList(done, lang)} today.`);
        parts.push(next ? `Next dose at ${next}.` : 'Nothing else to take today.');
    }
    return parts.join(' ');
}

function answerVisitors(f: CompanionFactsInput, lang: CompanionLang): string {
    const planned = f.events_today
        .filter((ev) => ev.category !== 'medical')
        .map((ev) => `${eventWho(ev, lang)} ${at(lang)} ${fmtTime(ev.start_time, lang)}`);
    const present = f.visits_today.filter((v) => !v.checked_out_at);
    const gone = f.visits_today.filter((v) => v.checked_out_at);
    const parts: string[] = [];
    if (lang === 'fr') {
        parts.push(planned.length > 0 ? `Aujourd'hui, visites prévues : ${joinList(planned, lang)}.` : "Personne n'est prévu aujourd'hui.");
        for (const v of present) parts.push(`${visitLabel(v, lang)} est là depuis ${fmtTime(v.checked_in_at, lang)}.`);
        for (const v of gone) parts.push(`Visite de ${visitLabel(v, lang)} à ${fmtTime(v.checked_in_at, lang)}.`);
    } else {
        parts.push(planned.length > 0 ? `Visits planned today: ${joinList(planned, lang)}.` : 'Nobody is planned today.');
        for (const v of present) parts.push(`${visitLabel(v, lang)} has been here since ${fmtTime(v.checked_in_at, lang)}.`);
        for (const v of gone) parts.push(`${visitLabel(v, lang)} visited at ${fmtTime(v.checked_in_at, lang)}.`);
    }
    return parts.join(' ');
}

function answerAppointments(f: CompanionFactsInput, lang: CompanionLang): string {
    const items = f.events_today
        .filter((ev) => ev.category === 'medical')
        .map((ev) => `${ev.title} ${at(lang)} ${fmtTime(ev.start_time, lang)}${ev.location ? `, ${ev.location}` : ''}`);
    if (items.length === 0) return lang === 'fr' ? "Pas de rendez-vous médical aujourd'hui." : 'No medical appointment today.';
    return lang === 'fr' ? `Tu as rendez-vous aujourd'hui : ${items.join(' ; ')}.` : `Your appointments today: ${items.join('; ')}.`;
}

function answerDatetime(now: Date, lang: CompanionLang): string {
    return lang === 'fr'
        ? `Nous sommes ${fmtDate(now, lang)}, il est ${fmtTime(now.toISOString(), lang)}.`
        : `Today is ${fmtDate(now, lang)}, it is ${fmtTime(now.toISOString(), lang)}.`;
}

function answerContacts(f: CompanionFactsInput, lang: CompanionLang): string {
    const items = f.contacts_key.slice(0, 4).map((c) => {
        const role = CONTACT_LABELS[lang][c.category] || '';
        const who = role ? `${c.name} (${role})` : c.name;
        return c.phone ? `${who} ${lang === 'fr' ? 'au' : 'on'} ${c.phone}` : who;
    });
    if (items.length === 0) {
        return lang === 'fr'
            ? "Je n'ai pas de numéro à te donner. Regarde dans « Mes informations » ou demande à ta famille."
            : 'I have no number to give you. Look in “My information” or ask your family.';
    }
    return lang === 'fr' ? `Tu peux appeler : ${items.join(' ; ')}.` : `You can call: ${items.join('; ')}.`;
}

function answerWeather(f: CompanionFactsInput, lang: CompanionLang): string {
    if (f.heatwave?.active) {
        return lang === 'fr'
            ? "Il fait très chaud en ce moment. Pense à boire de l'eau régulièrement et reste au frais."
            : 'It is very hot at the moment. Remember to drink water regularly and stay cool.';
    }
    return lang === 'fr'
        ? "La météo du jour est affichée en haut de l'écran. Je ne peux pas t'en dire plus."
        : 'The weather is shown at the top of the screen. I cannot tell you more.';
}

export function answerHelp(lang: CompanionLang): string {
    return lang === 'fr'
        ? "Si tu as besoin d'aide, appuie sur le gros bouton rouge « J'ai besoin d'aide » : ta famille est prévenue tout de suite. Je viens aussi de lui envoyer un signal."
        : 'If you need help, press the big red button “I need help”: your family is alerted right away. I have also just sent them a signal.';
}

export function distressHint(lang: CompanionLang): string {
    return lang === 'fr'
        ? " Si tu ne te sens pas bien, appuie sur le bouton rouge « J'ai besoin d'aide »."
        : ' If you do not feel well, press the red button “I need help”.';
}

/** Ce que le compagnon sait faire sans IA (repli quand aucune intention n'est reconnue). */
export function capabilitiesReply(lang: CompanionLang): string {
    return lang === 'fr'
        ? "Je peux te dire ce que tu dois prendre, qui vient aujourd'hui, tes rendez-vous, la date et qui appeler. Pose-moi une de ces questions."
        : 'I can tell you what to take, who is coming today, your appointments, the date and who to call. Ask me one of those.';
}

export function answerIntent(intent: CompanionIntent, facts: CompanionFactsInput, lang: CompanionLang, now: Date = new Date()): string {
    switch (intent) {
        case 'help': return answerHelp(lang);
        case 'medications': return answerMedications(facts, lang);
        case 'visitors': return answerVisitors(facts, lang);
        case 'appointments': return answerAppointments(facts, lang);
        case 'datetime': return answerDatetime(now, lang);
        case 'contacts': return answerContacts(facts, lang);
        case 'weather': return answerWeather(facts, lang);
    }
}

/** Bloc "aujourd'hui" injecte dans le prompt de l'IA, pour qu'elle n'invente rien. */
export function buildTodayFacts(facts: CompanionFactsInput, lang: CompanionLang, now: Date = new Date()): string {
    const L = (fr: string, en: string): string => (lang === 'fr' ? fr : en);
    const none = L('aucun', 'none');
    const due = facts.medications.due_now.map((i) => describeIntake(i, lang));
    const done = facts.medications.done.map((i) => i.medication_name);
    const planned = facts.events_today.filter((ev) => ev.category !== 'medical').map((ev) => `${eventWho(ev, lang)} ${at(lang)} ${fmtTime(ev.start_time, lang)}`);
    const medical = facts.events_today.filter((ev) => ev.category === 'medical').map((ev) => `${ev.title} ${at(lang)} ${fmtTime(ev.start_time, lang)}${ev.location ? `, ${ev.location}` : ''}`);
    const visits = facts.visits_today.map((v) => v.checked_out_at
        ? `${visitLabel(v, lang)} ${at(lang)} ${fmtTime(v.checked_in_at, lang)}`
        : `${visitLabel(v, lang)} ${L('là depuis', 'here since')} ${fmtTime(v.checked_in_at, lang)}`);
    const contacts = facts.contacts_key.slice(0, 4).map((c) => {
        const role = CONTACT_LABELS[lang][c.category];
        return `${c.name}${role ? ` (${role})` : ''}${c.phone ? ` ${c.phone}` : ''}`;
    });
    const next = facts.medications.next_due_at ? fmtTime(facts.medications.next_due_at, lang) : '';
    return [
        `- ${L('Date et heure', 'Date and time')} : ${fmtDate(now, lang)}, ${fmtTime(now.toISOString(), lang)}`,
        `- ${L('Médicaments à prendre maintenant', 'Medication due now')} : ${due.length ? due.join(' ; ') : none}`,
        `- ${L("Déjà pris aujourd'hui", 'Already taken today')} : ${done.length ? done.join(', ') : none}`,
        `- ${L('Prochaine prise', 'Next dose')} : ${next || L("plus rien aujourd'hui", 'nothing else today')}`,
        `- ${L("Visites prévues aujourd'hui", 'Visits planned today')} : ${planned.length ? planned.join(' ; ') : none}`,
        `- ${L('Visiteurs passés ou présents', 'Visitors who came or are here')} : ${visits.length ? visits.join(' ; ') : none}`,
        `- ${L('Rendez-vous médicaux', 'Medical appointments')} : ${medical.length ? medical.join(' ; ') : none}`,
        `- ${L('Personnes à appeler', 'People to call')} : ${contacts.length ? contacts.join(' ; ') : none}`,
        `- ${L('Canicule en cours', 'Heatwave in progress')} : ${facts.heatwave?.active ? L('oui', 'yes') : L('non', 'no')}`,
    ].join('\n');
}
