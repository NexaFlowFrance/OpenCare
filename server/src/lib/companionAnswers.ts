/**
 * "Demandez-moi" : reponses ancrees sur les donnees du cercle, sans IA.
 *
 * Detection d'intention par mots-cles (francais, anglais et espagnol) et phrase
 * de reponse construite a partir de l'instantane du jour : medicaments a prendre
 * maintenant, visites, rendez-vous, date et heure, personnes a appeler,
 * canicule. Le francais et l'espagnol tutoient, comme le reste du mode Kiosk.
 *
 * Module sans dependance. Une copie identique sert la demo statique
 * (client/src/demo/companionAnswers.ts) : garder les deux fichiers alignes.
 */

export type CompanionLang = 'fr' | 'en' | 'es';
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

// L'ordre compte : la demande d'aide passe avant tout le reste. Les motifs
// s'appliquent au texte normalise : "ayúdame" y devient "ayudame", "año" "ano".
// Pas de "toma" ni "tomar" seuls : "Tomás", une fois normalise, viendrait
// repondre medicaments a "Est-ce que Tomás vient aujourd'hui ?".
const PATTERNS: Array<[CompanionIntent, RegExp]> = [
    ['help', /\b(au secours|besoin d aide|aidez(-| )moi|aide(-| )moi|urgence|appelle (ma|la) famille|previens (ma|la) famille|help me|i need help|emergency|call (my|the) family|necesito ayuda|ayudame|socorro|auxilio|emergencia|urgencia|llama a (mi|la) familia|avisa a (mi|la) familia)\b/],
    ['medications', /\b(medicaments?|cachets?|comprimes?|gelules?|pilules?|pilulier|traitement|dois(-| )je prendre|dois prendre|faut prendre|quoi prendre|a prendre|prendre (mes|ce|quoi|quelque chose)|prises?|medications?|medicines?|pills?|tablets?|(should|do|must) i take|what (do|should) i take|my treatment|next dose|medicamentos?|medicinas?|pastillas?|comprimidos?|capsulas?|tratamiento|tengo que tomar|debo tomar|hay que tomar|que tomo|mis tomas|proxima toma|siguiente toma|dosis)\b/],
    ['visitors', /\b(qui vient|qui passe|qui va venir|qui doit venir|qui est venu|qui est la|qui est passe|qui est chez moi|visites?|visiteurs?|infirmier|infirmiere|aide a domicile|aide(-| )menagere|who is coming|who comes|who came|who is here|who visited|who is visiting|visitors?|visits?|the nurse|home aide|home help|quien viene|quien va a venir|quien vino|quien ha venido|quien esta aqui|quien esta en casa|visitas?|visitantes?|enfermer[oa]|auxiliar)\b/],
    ['appointments', /\b(rendez(-| )vous|rdv|docteur|medecin|dentiste|kine|kinesitherapeute|specialiste|hopital|consultation|agenda|programme|prevu aujourd hui|appointments?|doctor|dentist|physio|hospital|schedule|what is planned|planned today|citas?|medic[oa]|doctora|fisio|fisioterapeuta|especialista|consulta|que tengo hoy|que hay hoy)\b/],
    ['datetime', /\b(quel jour|quelle date|quelle heure|on est quel|nous sommes quel|quel mois|quelle annee|le combien|what day|what date|what time|what is the date|what month|what year|the date today|que dia|que fecha|que hora|en que dia|que mes|en que mes|que ano|a cuantos estamos)\b/],
    ['contacts', /\b(appeler|telephoner|numero|telephone|joindre|pharmacie|(who|whom) (can|should|do) i call|phone number|call the|call my|pharmacy|how do i reach|llamar|telefonear|telefono|contactar|farmacia|a quien (puedo|debo|tengo que) llamar)\b/],
    ['weather', /\b(meteo|temps qu il fait|quel temps|fait chaud|fait froid|canicule|chaleur|il pleut|pluie|weather|is it hot|is it cold|heatwave|raining|rain|que tiempo|hace calor|hace frio|ola de calor|calor|llueve|lluvia|clima)\b/],
];

const DISTRESS = /\b(j ai mal|ca fait mal|douleurs?|je suis tombee?|chute|j ai peur|angoissee?|je pleure|je saigne|vertiges?|malaise|etouffe|respire mal|je me sens mal|pas bien|tres seule?|mourir|it hurts|i m hurt|in pain|i fell|fallen|i m scared|afraid|bleeding|dizzy|faint|can t breathe|i feel sick|not well|want to die|so lonely|me duele|duele|dolor(es)?|me he caido|me cai|caida|tengo miedo|angustiad[oa]|estoy llorando|sangro|estoy sangrando|mareo|maread[oa]|desmayo|me ahogo|no puedo respirar|me siento mal|no estoy bien|muy sol[oa]|morir|me quiero morir)\b/;

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

/** Le texte d'une langue ; le type impose les trois variantes. */
const pick = <T>(lang: CompanionLang, variants: Record<CompanionLang, T>): T => variants[lang];

export function fmtTime(iso: string, lang: CompanionLang): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    if (lang === 'fr') return d.getMinutes() === 0 ? `${h} h` : `${h} h ${m}`;
    return `${h}:${m}`;
}

/** L'article espagnol devant une heure : "a la 1:30", "a las 10:00". */
const esArticle = (iso: string): string => (new Date(iso).getHours() === 1 ? 'la' : 'las');

/** "à 10 h", "at 10:00", "a las 10:00". */
const atTime = (iso: string, lang: CompanionLang): string =>
    pick(lang, { fr: `à ${fmtTime(iso, lang)}`, en: `at ${fmtTime(iso, lang)}`, es: `a ${esArticle(iso)} ${fmtTime(iso, lang)}` });

const fmtDate = (now: Date, lang: CompanionLang): string =>
    new Intl.DateTimeFormat(pick(lang, { fr: 'fr-FR', en: 'en-GB', es: 'es-ES' }), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);

const UNIT_LABELS: Record<CompanionLang, Record<string, [string, string]>> = {
    fr: { tablet: ['comprimé', 'comprimés'], capsule: ['gélule', 'gélules'], ml: ['ml', 'ml'], drop: ['goutte', 'gouttes'], sachet: ['sachet', 'sachets'], patch: ['patch', 'patchs'], injection: ['injection', 'injections'], puff: ['bouffée', 'bouffées'], application: ['application', 'applications'], dose: ['dose', 'doses'] },
    en: { tablet: ['tablet', 'tablets'], capsule: ['capsule', 'capsules'], ml: ['ml', 'ml'], drop: ['drop', 'drops'], sachet: ['sachet', 'sachets'], patch: ['patch', 'patches'], injection: ['injection', 'injections'], puff: ['puff', 'puffs'], application: ['application', 'applications'], dose: ['dose', 'doses'] },
    es: { tablet: ['comprimido', 'comprimidos'], capsule: ['cápsula', 'cápsulas'], ml: ['ml', 'ml'], drop: ['gota', 'gotas'], sachet: ['sobre', 'sobres'], patch: ['parche', 'parches'], injection: ['inyección', 'inyecciones'], puff: ['inhalación', 'inhalaciones'], application: ['aplicación', 'aplicaciones'], dose: ['dosis', 'dosis'] },
};

const VISITOR_LABELS: Record<CompanionLang, Record<string, string>> = {
    fr: { family: 'famille', friend: 'ami ou voisin', caregiver: 'aide à domicile', nurse: 'soins infirmiers', doctor: 'médecin', other: '' },
    en: { family: 'family', friend: 'friend or neighbour', caregiver: 'home aide', nurse: 'nurse', doctor: 'doctor', other: '' },
    es: { family: 'familia', friend: 'amigo o vecino', caregiver: 'auxiliar a domicilio', nurse: 'enfermería', doctor: 'médico', other: '' },
};

const EVENT_LABELS: Record<CompanionLang, Record<string, string>> = {
    fr: { nurse: "l'infirmier ou l'infirmière", aide: "l'aide à domicile" },
    en: { nurse: 'the nurse', aide: 'the home aide' },
    es: { nurse: 'el enfermero o la enfermera', aide: 'la auxiliar a domicilio' },
};

const CONTACT_LABELS: Record<CompanionLang, Record<string, string>> = {
    fr: { doctor: 'médecin', nurse: 'soins infirmiers', aide: 'aide à domicile', physio: 'kiné', pharmacy: 'pharmacie' },
    en: { doctor: 'doctor', nurse: 'nurse', aide: 'home aide', physio: 'physio', pharmacy: 'pharmacy' },
    es: { doctor: 'médico', nurse: 'enfermería', aide: 'auxiliar a domicilio', physio: 'fisio', pharmacy: 'farmacia' },
};

const joinList = (items: string[], lang: CompanionLang): string => {
    if (items.length <= 1) return items.join('');
    const and = pick(lang, { fr: ' et ', en: ' and ', es: ' y ' });
    return `${items.slice(0, -1).join(', ')}${and}${items[items.length - 1]}`;
};

/** "Metformine, 2 comprimés" (ou le dosage textuel si la quantite manque). */
export function describeIntake(intake: FactsIntake, lang: CompanionLang): string {
    const q = Number(intake.quantity);
    if (!Number.isFinite(q) || q <= 0) return intake.dosage ? `${intake.medication_name} (${intake.dosage})` : intake.medication_name;
    const labels = UNIT_LABELS[lang][intake.unit || ''];
    const qs = Number.isInteger(q) ? String(q) : String(q).replace('.', lang === 'en' ? '.' : ',');
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

// ── Reponses ──

function answerMedications(f: CompanionFactsInput, lang: CompanionLang): string {
    const due = f.medications.due_now.map((i) => describeIntake(i, lang));
    if (due.length > 0) {
        return pick(lang, {
            fr: `Maintenant, tu dois prendre : ${joinList(due, lang)}. Appuie sur le bouton vert quand c'est fait.`,
            en: `Right now you need to take: ${joinList(due, lang)}. Tap the green button when it is done.`,
            es: `Ahora tienes que tomar: ${joinList(due, lang)}. Pulsa el botón verde cuando lo hayas hecho.`,
        });
    }
    const done = f.medications.done.map((i) => i.medication_name);
    const nextIso = f.medications.next_due_at;
    const next = nextIso ? fmtTime(nextIso, lang) : '';
    const parts: string[] = [];
    if (lang === 'fr') {
        parts.push("Rien à prendre pour l'instant.");
        if (done.length > 0) parts.push(`Tu as déjà pris ${joinList(done, lang)} aujourd'hui.`);
        parts.push(next ? `Prochaine prise à ${next}.` : "Plus rien à prendre aujourd'hui.");
    } else if (lang === 'es') {
        parts.push('Nada que tomar por ahora.');
        if (done.length > 0) parts.push(`Hoy ya has tomado ${joinList(done, lang)}.`);
        parts.push(nextIso && next ? `Próxima toma ${atTime(nextIso, lang)}.` : 'No queda nada por tomar hoy.');
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
        .map((ev) => `${eventWho(ev, lang)} ${atTime(ev.start_time, lang)}`);
    const present = f.visits_today.filter((v) => !v.checked_out_at);
    const gone = f.visits_today.filter((v) => v.checked_out_at);
    const parts: string[] = [];
    if (lang === 'fr') {
        parts.push(planned.length > 0 ? `Aujourd'hui, visites prévues : ${joinList(planned, lang)}.` : "Personne n'est prévu aujourd'hui.");
        for (const v of present) parts.push(`${visitLabel(v, lang)} est là depuis ${fmtTime(v.checked_in_at, lang)}.`);
        for (const v of gone) parts.push(`Visite de ${visitLabel(v, lang)} à ${fmtTime(v.checked_in_at, lang)}.`);
    } else if (lang === 'es') {
        parts.push(planned.length > 0 ? `Visitas previstas hoy: ${joinList(planned, lang)}.` : 'Hoy no viene nadie.');
        for (const v of present) parts.push(`${visitLabel(v, lang)} está aquí desde ${esArticle(v.checked_in_at)} ${fmtTime(v.checked_in_at, lang)}.`);
        for (const v of gone) parts.push(`Visita de ${visitLabel(v, lang)} ${atTime(v.checked_in_at, lang)}.`);
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
        .map((ev) => `${ev.title} ${atTime(ev.start_time, lang)}${ev.location ? `, ${ev.location}` : ''}`);
    if (items.length === 0) {
        return pick(lang, { fr: "Pas de rendez-vous médical aujourd'hui.", en: 'No medical appointment today.', es: 'Hoy no tienes ninguna cita médica.' });
    }
    return pick(lang, {
        fr: `Tu as rendez-vous aujourd'hui : ${items.join(' ; ')}.`,
        en: `Your appointments today: ${items.join('; ')}.`,
        es: `Hoy tienes cita: ${items.join('; ')}.`,
    });
}

function answerDatetime(now: Date, lang: CompanionLang): string {
    const iso = now.toISOString();
    return pick(lang, {
        fr: `Nous sommes ${fmtDate(now, lang)}, il est ${fmtTime(iso, lang)}.`,
        en: `Today is ${fmtDate(now, lang)}, it is ${fmtTime(iso, lang)}.`,
        es: `Hoy es ${fmtDate(now, lang)}, ${esArticle(iso) === 'la' ? 'es la' : 'son las'} ${fmtTime(iso, lang)}.`,
    });
}

function answerContacts(f: CompanionFactsInput, lang: CompanionLang): string {
    const items = f.contacts_key.slice(0, 4).map((c) => {
        const role = CONTACT_LABELS[lang][c.category] || '';
        const who = role ? `${c.name} (${role})` : c.name;
        return c.phone ? `${who} ${pick(lang, { fr: 'au', en: 'on', es: 'al' })} ${c.phone}` : who;
    });
    if (items.length === 0) {
        return pick(lang, {
            fr: "Je n'ai pas de numéro à te donner. Regarde dans « Mes informations » ou demande à ta famille.",
            en: 'I have no number to give you. Look in “My information” or ask your family.',
            es: 'No tengo ningún número que darte. Mira en «Mi información» o pregunta a tu familia.',
        });
    }
    return pick(lang, {
        fr: `Tu peux appeler : ${items.join(' ; ')}.`,
        en: `You can call: ${items.join('; ')}.`,
        es: `Puedes llamar a: ${items.join('; ')}.`,
    });
}

function answerWeather(f: CompanionFactsInput, lang: CompanionLang): string {
    if (f.heatwave?.active) {
        return pick(lang, {
            fr: "Il fait très chaud en ce moment. Pense à boire de l'eau régulièrement et reste au frais.",
            en: 'It is very hot at the moment. Remember to drink water regularly and stay cool.',
            es: 'Hace mucho calor ahora mismo. Acuérdate de beber agua a menudo y quédate en un sitio fresco.',
        });
    }
    return pick(lang, {
        fr: "La météo du jour est affichée en haut de l'écran. Je ne peux pas t'en dire plus.",
        en: 'The weather is shown at the top of the screen. I cannot tell you more.',
        es: 'El tiempo de hoy aparece arriba en la pantalla. No puedo decirte más.',
    });
}

export function answerHelp(lang: CompanionLang): string {
    return pick(lang, {
        fr: "Si tu as besoin d'aide, appuie sur le gros bouton rouge « J'ai besoin d'aide » : ta famille est prévenue tout de suite. Je viens aussi de lui envoyer un signal.",
        en: 'If you need help, press the big red button “I need help”: your family is alerted right away. I have also just sent them a signal.',
        es: 'Si necesitas ayuda, pulsa el botón rojo grande «Necesito ayuda»: tu familia recibe el aviso enseguida. Yo también acabo de enviarle una señal.',
    });
}

export function distressHint(lang: CompanionLang): string {
    return pick(lang, {
        fr: " Si tu ne te sens pas bien, appuie sur le bouton rouge « J'ai besoin d'aide ».",
        en: ' If you do not feel well, press the red button “I need help”.',
        es: ' Si no te encuentras bien, pulsa el botón rojo «Necesito ayuda».',
    });
}

/** Ce que le compagnon sait faire sans IA (repli quand aucune intention n'est reconnue). */
export function capabilitiesReply(lang: CompanionLang): string {
    return pick(lang, {
        fr: "Je peux te dire ce que tu dois prendre, qui vient aujourd'hui, tes rendez-vous, la date et qui appeler. Pose-moi une de ces questions.",
        en: 'I can tell you what to take, who is coming today, your appointments, the date and who to call. Ask me one of those.',
        es: 'Puedo decirte qué tienes que tomar, quién viene hoy, tus citas, la fecha y a quién llamar. Hazme una de esas preguntas.',
    });
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
    const L = (fr: string, en: string, es: string): string => pick(lang, { fr, en, es });
    const none = L('aucun', 'none', 'ninguno');
    const due = facts.medications.due_now.map((i) => describeIntake(i, lang));
    const done = facts.medications.done.map((i) => i.medication_name);
    const planned = facts.events_today.filter((ev) => ev.category !== 'medical').map((ev) => `${eventWho(ev, lang)} ${atTime(ev.start_time, lang)}`);
    const medical = facts.events_today.filter((ev) => ev.category === 'medical').map((ev) => `${ev.title} ${atTime(ev.start_time, lang)}${ev.location ? `, ${ev.location}` : ''}`);
    const visits = facts.visits_today.map((v) => v.checked_out_at
        ? `${visitLabel(v, lang)} ${atTime(v.checked_in_at, lang)}`
        : `${visitLabel(v, lang)} ${L('là depuis', 'here since', 'aquí desde')} ${fmtTime(v.checked_in_at, lang)}`);
    const contacts = facts.contacts_key.slice(0, 4).map((c) => {
        const role = CONTACT_LABELS[lang][c.category];
        return `${c.name}${role ? ` (${role})` : ''}${c.phone ? ` ${c.phone}` : ''}`;
    });
    const next = facts.medications.next_due_at ? fmtTime(facts.medications.next_due_at, lang) : '';
    return [
        `- ${L('Date et heure', 'Date and time', 'Fecha y hora')} : ${fmtDate(now, lang)}, ${fmtTime(now.toISOString(), lang)}`,
        `- ${L('Médicaments à prendre maintenant', 'Medication due now', 'Medicamentos que tomar ahora')} : ${due.length ? due.join(' ; ') : none}`,
        `- ${L("Déjà pris aujourd'hui", 'Already taken today', 'Ya tomados hoy')} : ${done.length ? done.join(', ') : none}`,
        `- ${L('Prochaine prise', 'Next dose', 'Próxima toma')} : ${next || L("plus rien aujourd'hui", 'nothing else today', 'nada más hoy')}`,
        `- ${L("Visites prévues aujourd'hui", 'Visits planned today', 'Visitas previstas hoy')} : ${planned.length ? planned.join(' ; ') : none}`,
        `- ${L('Visiteurs passés ou présents', 'Visitors who came or are here', 'Visitantes que han venido o están aquí')} : ${visits.length ? visits.join(' ; ') : none}`,
        `- ${L('Rendez-vous médicaux', 'Medical appointments', 'Citas médicas')} : ${medical.length ? medical.join(' ; ') : none}`,
        `- ${L('Personnes à appeler', 'People to call', 'Personas a las que llamar')} : ${contacts.length ? contacts.join(' ; ') : none}`,
        `- ${L('Canicule en cours', 'Heatwave in progress', 'Ola de calor en curso')} : ${facts.heatwave?.active ? L('oui', 'yes', 'sí') : L('non', 'no', 'no')}`,
    ].join('\n');
}
