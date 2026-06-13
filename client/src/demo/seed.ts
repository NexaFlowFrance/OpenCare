// Seed du mode démo statique (GitHub Pages, VITE_DEMO=1). Tout vit en mémoire
// et est régénéré à chaque chargement de page : rien n'est persisté. Les dates
// sont calculées par rapport à « maintenant » pour que la démo paraisse vivante.
//
// Persona : Marie Dupont (compte connecté, admin) coordonne les aidants de sa
// mère Jeanne Dupont (87 ans, cercle « Jeanne ») avec son frère Paul (family),
// Nadia (auxiliaire de vie via lien magique, sans compte) et le Dr Martin
// (médecin traitant, dans les contacts). Un second cercle minimal « Papa »
// (Robert, 89 ans) illustre le multi-proches.

export type Json = Record<string, any>;

const pad = (n: number) => String(n).padStart(2, '0');
const now = new Date();
const y = now.getFullYear();

const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const atTime = (d: Date, h: number, min = 0) => `${isoDate(d)}T${pad(h)}:${pad(min)}:00`;
const addDays = (base: Date, days: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
};
/** Horodatage naïf local à `offset` jours de maintenant, à h:min. */
const at = (offset: number, h: number, min = 0) => atTime(addDays(now, offset), h, min);
/** Date locale YYYY-MM-DD à `offset` jours de maintenant. */
const dstr = (offset: number) => isoDate(addDays(now, offset));

/** Lundi de la semaine courante (pour la synthèse hebdo). */
const mondayOffset = -((now.getDay() + 6) % 7);

/** PNG 1x1 : assez pour faire vivre les aperçus de documents sans fichier lourd. */
export const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Toutes les données d'un cercle de soin (équivalent des tables scoping circle_id). */
export interface CircleData {
    id: string;
    name: string;
    currency: string;
    settings: Json;
    created_at: string;
    /** Rôle de Marie (le compte démo) dans ce cercle. */
    role: string;
    color: string;
    recipient: Json;
    members: Json[];
    invites: Json[];
    caregiverLinks: Json[];
    journal: Json[];
    vitals: Json[];
    medications: Json[];
    /** Statuts forcés des prises (clé: id de prise générée). */
    intakeOverrides: Json;
    prescriptions: Json[];
    events: Json[];
    tasks: Json[];
    shopping: Json[];
    messages: Json[];
    documents: Json[];
    contacts: Json[];
    expenses: Json[];
    settlements: Json[];
    aids: Json[];
    notes: Json[];
    story: Json;
    emergencySheet: Json;
    digests: Json[];
    presenceSignals: Json[];
    presenceRule: Json | null;
    presenceWebhookUrl: string | null;
}

export interface DemoStore {
    /** Le compte connecté (Marie). */
    user: Json;
    /** Les comptes des membres, pour les lookups de nom/avatar. */
    users: Json[];
    circles: CircleData[];
    notifications: Json[];
    calendarToken: string;
}

const half = (amount: number) => Math.round((amount / 2) * 100) / 100;
const equalSplits = (amount: number, memberIds: string[]) =>
    memberIds.map((member_id) => ({ member_id, share: half(amount) }));

export function createSeed(): DemoStore {
    const marie = { id: 'u-marie', name: 'Marie Dupont', email: 'marie@demo.opencare.fr', avatar_url: null, language: 'fr' };
    const paul = { id: 'u-paul', name: 'Paul Dupont', email: 'paul@demo.opencare.fr', avatar_url: null, language: 'fr' };

    const cmMarie = {
        id: 'cm-marie', circle_id: 'c-jeanne', user_id: 'u-marie', role: 'admin', color: '#2563EB',
        created_at: dstr(-200), name: marie.name, email: marie.email, avatar_url: null,
    };
    const cmPaul = {
        id: 'cm-paul', circle_id: 'c-jeanne', user_id: 'u-paul', role: 'family', color: '#16A34A',
        created_at: dstr(-195), name: paul.name, email: paul.email, avatar_url: null,
    };

    const sharingIds = [cmMarie.id, cmPaul.id];

    // ── Médicaments de Jeanne (3 traitements, horaires quotidiens) ────────────
    const medications = [
        {
            id: 'med-amlo', circle_id: 'c-jeanne', name: 'Amlodipine 5 mg', dosage: '1 comprimé', form: 'Comprimé',
            instructions: 'À prendre le matin avec un grand verre d\'eau', photo_url: null, prescriber: 'Dr Martin',
            start_date: dstr(-400), end_date: null, active: true,
            schedules: [
                { id: 'sch-amlo-1', medication_id: 'med-amlo', time_of_day: '08:00', days_of_week: [1, 2, 3, 4, 5, 6, 7], label: 'Matin' },
            ],
        },
        {
            id: 'med-karde', circle_id: 'c-jeanne', name: 'Kardégic 75 mg', dosage: '1 sachet', form: 'Poudre',
            instructions: 'À diluer dans un demi-verre d\'eau, pendant le petit-déjeuner', photo_url: null, prescriber: 'Dr Martin',
            start_date: dstr(-400), end_date: null, active: true,
            schedules: [
                { id: 'sch-karde-1', medication_id: 'med-karde', time_of_day: '08:00', days_of_week: [1, 2, 3, 4, 5, 6, 7], label: 'Matin' },
            ],
        },
        {
            id: 'med-doli', circle_id: 'c-jeanne', name: 'Doliprane 1000 mg', dosage: '1 comprimé', form: 'Comprimé',
            instructions: 'Si douleurs (genoux), maximum 3 par jour', photo_url: null, prescriber: 'Dr Martin',
            start_date: dstr(-60), end_date: null, active: true,
            schedules: [
                { id: 'sch-doli-1', medication_id: 'med-doli', time_of_day: '08:00', days_of_week: [1, 2, 3, 4, 5, 6, 7], label: 'Matin' },
                { id: 'sch-doli-2', medication_id: 'med-doli', time_of_day: '20:00', days_of_week: [1, 2, 3, 4, 5, 6, 7], label: 'Soir' },
            ],
        },
    ];

    // Statuts des prises du jour (et quelques oublis passés pour les courbes
    // d'observance) : la clé reprend le format d'id généré par mockApi.
    const intakeOverrides: Json = {
        [`in_med-amlo_sch-amlo-1_${dstr(0)}`]: { status: 'taken', confirmed_at: at(0, 8, 10), confirmed_by: 'Nadia', journal_entry_id: 'j-med-1' },
        [`in_med-doli_sch-doli-1_${dstr(0)}`]: { status: 'taken', confirmed_at: at(0, 8, 12), confirmed_by: 'Nadia', journal_entry_id: null },
        [`in_med-karde_sch-karde-1_${dstr(0)}`]: { status: 'missed', confirmed_at: null, confirmed_by: null, journal_entry_id: null },
        [`in_med-doli_sch-doli-2_${dstr(-3)}`]: { status: 'skipped', confirmed_at: at(-3, 20, 25), confirmed_by: 'Marie Dupont', journal_entry_id: null },
        [`in_med-karde_sch-karde-1_${dstr(-9)}`]: { status: 'missed', confirmed_at: null, confirmed_by: null, journal_entry_id: null },
        [`in_med-amlo_sch-amlo-1_${dstr(-16)}`]: { status: 'missed', confirmed_at: null, confirmed_by: null, journal_entry_id: null },
    };

    // ── Journal de liaison : 2 semaines + quelques entrées plus anciennes ─────
    const entry = (
        id: string, offset: number, h: number, min: number,
        author: 'marie' | 'paul' | 'nadia', type: string, content: string, data: Json = {}
    ): Json => ({
        id,
        circle_id: 'c-jeanne',
        author_user_id: author === 'marie' ? 'u-marie' : author === 'paul' ? 'u-paul' : null,
        caregiver_link_id: author === 'nadia' ? 'cl-nadia' : null,
        author_name: author === 'marie' ? 'Marie Dupont' : author === 'paul' ? 'Paul Dupont' : 'Nadia',
        type,
        content,
        data,
        occurred_at: at(offset, h, min),
        created_at: at(offset, h, min),
        photos: [],
    });

    const journal = [
        entry('j-1', 0, 8, 15, 'nadia', 'visit',
            'Passage du matin : toilette faite, petit-déjeuner complet. Jeanne était de bonne humeur, on a écouté la radio ensemble.'),
        entry('j-med-1', 0, 8, 10, 'nadia', 'medication', 'Amlodipine 5 mg 1 comprimé',
            { medication_id: 'med-amlo', status: 'taken' }),
        entry('j-2', -1, 17, 30, 'marie', 'visit',
            'Passée après le travail. Maman avait bonne mine, on a regardé les photos du baptême de Léa.'),
        entry('j-3', -1, 9, 0, 'nadia', 'mood',
            'Moral un peu en baisse ce matin, elle parle beaucoup de papa. Je l\'ai laissée avec ses mots croisés.'),
        entry('j-4', -2, 8, 20, 'nadia', 'visit',
            'Toilette et ménage de la cuisine. Appétit moyen ce midi, la soupe d\'hier soir est presque finie.'),
        entry('j-5', -2, 12, 0, 'paul', 'note',
            'J\'ai déposé les courses, le frigo est plein. Pensez à racheter du café moulu la prochaine fois.'),
        entry('j-6', -3, 10, 0, 'marie', 'vital',
            'Tension prise ce matin, tout est stable.',
            { vital_type: 'bp', value: 138, value2: 82, unit: 'mmHg' }),
        entry('j-7', -4, 8, 25, 'nadia', 'visit',
            'Passage habituel. Jeanne a bien dormi, elle attend la visite de Paul avec impatience.'),
        entry('j-8', -5, 11, 30, 'nadia', 'incident',
            'Jeanne a glissé dans la cuisine en voulant attraper la cafetière. Plus de peur que de mal : elle s\'est rattrapée au plan de travail, pas de chute. J\'ai remis le tapis antidérapant devant l\'évier.'),
        entry('j-9', -5, 19, 0, 'marie', 'note',
            'Appelé le Dr Martin suite à la glissade : rien d\'inquiétant, il rappelle de bien utiliser la canne, même dans l\'appartement.'),
        entry('j-10', -6, 14, 0, 'paul', 'visit',
            'Après-midi jeux de cartes, maman m\'a encore battu à la belote. On a goûté avec les sablés de la voisine.'),
        entry('j-11', -7, 8, 30, 'nadia', 'mood',
            'Très bonne journée : Jeanne a chantonné du Brassens pendant toute la toilette.'),
        entry('j-12', -9, 16, 0, 'marie', 'visit',
            'Goûter avec maman, on a préparé la liste de courses ensemble. Elle voudrait des compotes pomme-rhubarbe.'),
        entry('j-13', -10, 20, 30, 'marie', 'mood',
            'Maman semblait fatiguée au téléphone ce soir, elle s\'est couchée tôt.'),
        entry('j-14', -11, 8, 20, 'nadia', 'visit',
            'Tout va bien ce matin. La kiné de la résidence est passée pour les exercices d\'équilibre.'),
        entry('j-15', -12, 18, 0, 'paul', 'note',
            'Le robinet de la salle de bain goutte, je passerai samedi avec ma caisse à outils.'),
        entry('j-16', -13, 15, 0, 'marie', 'visit',
            'Visite avec les enfants, maman était ravie. Pesée du mois faite : poids stable.',
            { vital_type: 'weight', value: 58.2, unit: 'kg' }),
        entry('j-17', -14, 8, 15, 'nadia', 'visit',
            'Reprise après mon week-end. Jeanne va bien, le pilulier était bien suivi.'),
        // Entrées plus anciennes : alimentent la période précédente de l'équité.
        entry('j-18', -22, 15, 0, 'marie', 'visit', 'Visite du dimanche, déjeuner ensemble.'),
        entry('j-19', -27, 11, 0, 'paul', 'visit', 'Passage rapide pour changer l\'ampoule du couloir.'),
        entry('j-20', -34, 16, 30, 'marie', 'visit', 'Goûter et papiers de la mutuelle remplis ensemble.'),
        entry('j-21', -41, 14, 0, 'marie', 'visit', 'Promenade au parc de la Tête d\'Or, beau temps.'),
    ];

    // ── Constantes : poids stable, tension sur 3 mois, moral sur 2 semaines ───
    const vital = (id: string, offset: number, h: number, type: string, value: number, value2: number | null, unit: string | null, by: string | null): Json => ({
        id, circle_id: 'c-jeanne', type, value, value2, unit,
        measured_at: at(offset, h), journal_entry_id: null, recorded_by_user: by, notes: null,
        created_at: at(offset, h),
    });

    const vitals = [
        vital('v-w1', -84, 10, 'weight', 58.9, null, 'kg', 'u-marie'),
        vital('v-w2', -70, 10, 'weight', 58.6, null, 'kg', 'u-marie'),
        vital('v-w3', -56, 10, 'weight', 58.4, null, 'kg', 'u-paul'),
        vital('v-w4', -42, 10, 'weight', 58.5, null, 'kg', 'u-marie'),
        vital('v-w5', -28, 10, 'weight', 58.3, null, 'kg', 'u-marie'),
        vital('v-w6', -13, 15, 'weight', 58.2, null, 'kg', 'u-marie'),
        vital('v-bp1', -84, 9, 'bp', 146, 88, 'mmHg', 'u-marie'),
        vital('v-bp2', -75, 9, 'bp', 142, 86, 'mmHg', 'u-marie'),
        vital('v-bp3', -66, 9, 'bp', 140, 85, 'mmHg', 'u-paul'),
        vital('v-bp4', -56, 9, 'bp', 138, 84, 'mmHg', 'u-marie'),
        vital('v-bp5', -47, 9, 'bp', 136, 82, 'mmHg', 'u-marie'),
        vital('v-bp6', -38, 9, 'bp', 139, 85, 'mmHg', 'u-paul'),
        vital('v-bp7', -28, 9, 'bp', 137, 83, 'mmHg', 'u-marie'),
        vital('v-bp8', -19, 9, 'bp', 135, 82, 'mmHg', 'u-marie'),
        vital('v-bp9', -10, 9, 'bp', 138, 83, 'mmHg', 'u-marie'),
        vital('v-bp10', -3, 10, 'bp', 138, 82, 'mmHg', 'u-marie'),
        vital('v-m1', -12, 9, 'mood', 7, null, null, 'u-marie'),
        vital('v-m2', -9, 9, 'mood', 6, null, null, 'u-marie'),
        vital('v-m3', -7, 9, 'mood', 8, null, null, 'u-paul'),
        vital('v-m4', -5, 12, 'mood', 4, null, null, 'u-marie'),
        vital('v-m5', -1, 9, 'mood', 6, null, null, 'u-marie'),
    ];

    // ── Calendrier : passages récurrents + rendez-vous à venir ────────────────
    const events = [
        {
            id: 'ev-nurse', circle_id: 'c-jeanne', title: 'Passage infirmière (pilulier et tension)',
            description: 'Cabinet infirmier des Lilas', category: 'nurse',
            start_time: at(-21, 9, 0), end_time: at(-21, 9, 30), location: 'Domicile',
            rrule: 'FREQ=WEEKLY;BYDAY=MO,TH', member_ids: [], reminder_30min: false, reminder_1hour: false,
            notes: null, created_by: 'u-marie', created_at: dstr(-21),
        },
        {
            id: 'ev-nadia', circle_id: 'c-jeanne', title: 'Passage de Nadia (auxiliaire de vie)',
            description: 'Toilette, petit-déjeuner, médicaments du matin', category: 'aide',
            start_time: at(-30, 8, 0), end_time: at(-30, 9, 0), location: 'Domicile',
            rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA', member_ids: [], reminder_30min: false, reminder_1hour: false,
            notes: null, created_by: 'u-marie', created_at: dstr(-30),
        },
        {
            id: 'ev-cardio', circle_id: 'c-jeanne', title: 'Cardiologue : Dr Lefèvre',
            description: 'Contrôle annuel, apporter la dernière ordonnance', category: 'medical',
            start_time: at(9, 14, 30), end_time: at(9, 15, 30), location: 'Clinique du Parc, Lyon 6e',
            rrule: null, member_ids: [cmMarie.id], reminder_30min: false, reminder_1hour: true,
            notes: 'Paul gère le taxi médical', created_by: 'u-marie', created_at: dstr(-12),
        },
        {
            id: 'ev-visit-marie', circle_id: 'c-jeanne', title: 'Visite de Marie',
            description: null, category: 'visit',
            start_time: at(2, 15, 0), end_time: at(2, 17, 0), location: 'Domicile',
            rrule: null, member_ids: [cmMarie.id], reminder_30min: true, reminder_1hour: false,
            notes: null, created_by: 'u-marie', created_at: dstr(-4),
        },
        {
            id: 'ev-visit-paul', circle_id: 'c-jeanne', title: 'Visite de Paul (réparation robinet)',
            description: null, category: 'visit',
            start_time: at(5, 11, 0), end_time: at(5, 12, 30), location: 'Domicile',
            rrule: null, member_ids: [cmPaul.id], reminder_30min: false, reminder_1hour: false,
            notes: null, created_by: 'u-paul', created_at: dstr(-2),
        },
        {
            id: 'ev-past-marie', circle_id: 'c-jeanne', title: 'Visite de Marie',
            description: null, category: 'visit',
            start_time: at(-9, 16, 0), end_time: at(-9, 18, 0), location: 'Domicile',
            rrule: null, member_ids: [cmMarie.id], reminder_30min: false, reminder_1hour: false,
            notes: null, created_by: 'u-marie', created_at: dstr(-15),
        },
        {
            id: 'ev-past-paul', circle_id: 'c-jeanne', title: 'Visite de Paul',
            description: null, category: 'visit',
            start_time: at(-6, 14, 0), end_time: at(-6, 16, 0), location: 'Domicile',
            rrule: null, member_ids: [cmPaul.id], reminder_30min: false, reminder_1hour: false,
            notes: null, created_by: 'u-paul', created_at: dstr(-10),
        },
    ];

    // ── Tâches ────────────────────────────────────────────────────────────────
    const tasks = [
        {
            id: 'tk-1', circle_id: 'c-jeanne', title: 'Courses de la semaine', description: 'Voir la liste partagée',
            category: 'shopping', is_completed: false, due_date: at(1, 18, 0), frequency: null, priority: 'Moyenne',
            assigned_to: [cmPaul.id], completed_at: null, completed_by: null, created_at: at(-1, 9, 0),
        },
        {
            id: 'tk-2', circle_id: 'c-jeanne', title: 'Renouveler l\'ordonnance à la pharmacie', description: 'Ordonnance du Dr Martin dans les documents',
            category: 'pharmacy', is_completed: false, due_date: at(3, 12, 0), frequency: null, priority: 'Haute',
            assigned_to: [cmMarie.id], completed_at: null, completed_by: null, created_at: at(-2, 10, 0),
        },
        {
            id: 'tk-3', circle_id: 'c-jeanne', title: 'Confirmer le taxi médical pour le cardiologue', description: null,
            category: 'transport', is_completed: false, due_date: at(7, 18, 0), frequency: null, priority: 'Moyenne',
            assigned_to: [cmPaul.id], completed_at: null, completed_by: null, created_at: at(-1, 14, 0),
        },
        {
            id: 'tk-4', circle_id: 'c-jeanne', title: 'Lessive et changement des draps', description: null,
            category: 'laundry', is_completed: true, due_date: at(-4, 12, 0), frequency: null, priority: 'Basse',
            assigned_to: [cmPaul.id], completed_at: at(-4, 11, 30), completed_by: 'u-paul', created_at: at(-7, 9, 0),
        },
        {
            id: 'tk-5', circle_id: 'c-jeanne', title: 'Déclarer le CESU de Nadia', description: null,
            category: 'admin', is_completed: true, due_date: at(-8, 12, 0), frequency: null, priority: 'Moyenne',
            assigned_to: [cmMarie.id], completed_at: at(-8, 21, 0), completed_by: 'u-marie', created_at: at(-12, 9, 0),
        },
        {
            id: 'tk-6', circle_id: 'c-jeanne', title: 'Payer la facture du SSIAD', description: null,
            category: 'admin', is_completed: true, due_date: at(-25, 12, 0), frequency: null, priority: 'Moyenne',
            assigned_to: [cmMarie.id], completed_at: at(-25, 19, 0), completed_by: 'u-marie', created_at: at(-30, 9, 0),
        },
    ];

    // ── Courses ───────────────────────────────────────────────────────────────
    const shopping = [
        { id: 'sh-1', circle_id: 'c-jeanne', name: 'Soupe de légumes (briques)', category: 'food', quantity: 4, unit: null, is_checked: false, notes: 'Elle préfère la marque Knorr', added_by: 'u-marie', created_at: at(-1, 9, 0) },
        { id: 'sh-2', circle_id: 'c-jeanne', name: 'Compotes pomme-rhubarbe', category: 'food', quantity: 8, unit: null, is_checked: false, notes: null, added_by: 'u-marie', created_at: at(-1, 9, 1) },
        { id: 'sh-3', circle_id: 'c-jeanne', name: 'Café moulu', category: 'food', quantity: 1, unit: 'paquet', is_checked: false, notes: null, added_by: 'u-paul', created_at: at(-2, 12, 5) },
        { id: 'sh-4', circle_id: 'c-jeanne', name: 'Eau gazeuse', category: 'food', quantity: 1, unit: 'pack', is_checked: false, notes: null, added_by: 'u-paul', created_at: at(-2, 12, 6) },
        { id: 'sh-5', circle_id: 'c-jeanne', name: 'Savon doux sans parfum', category: 'hygiene', quantity: 2, unit: null, is_checked: false, notes: 'Demandé par Nadia', added_by: 'u-marie', created_at: at(-3, 18, 0) },
        { id: 'sh-6', circle_id: 'c-jeanne', name: 'Pain de mie complet', category: 'food', quantity: 1, unit: null, is_checked: true, notes: null, added_by: 'u-marie', created_at: at(-4, 9, 0) },
        { id: 'sh-7', circle_id: 'c-jeanne', name: 'Vitamine D (pharmacie)', category: 'pharmacy', quantity: 1, unit: 'flacon', is_checked: true, notes: 'Sur ordonnance', added_by: 'u-marie', created_at: at(-5, 9, 0) },
    ];

    // ── Messages : fil du cercle + un échange privé Marie/Paul ───────────────
    const msg = (id: string, offset: number, h: number, min: number, author: Json, content: string, channel = 'circle', recipient: string | null = null): Json => ({
        id, circle_id: 'c-jeanne', channel, author_user_id: author.id, recipient_user_id: recipient,
        content, attachments: [], edited_at: null, created_at: at(offset, h, min),
        author_name: author.name, author_avatar: null,
    });

    const messages = [
        msg('ms-1', -6, 18, 30, marie, 'La glissade d\'hier m\'inquiète un peu. Je propose qu\'on demande au kiné de revoir les exercices d\'équilibre.'),
        msg('ms-2', -6, 19, 5, paul, 'Bonne idée. J\'installe une deuxième barre d\'appui dans la salle de bain samedi, j\'ai déjà le matériel.'),
        msg('ms-3', -5, 8, 50, marie, 'Merci ! Nadia a remis le tapis antidérapant devant l\'évier en attendant.'),
        msg('ms-4', -3, 12, 10, paul, 'RDV cardiologue confirmé pour le ' + dstr(9).slice(8, 10) + '. Je m\'occupe du taxi médical.'),
        msg('ms-5', -2, 20, 15, marie, 'Maman réclame des compotes pomme-rhubarbe, je les ai ajoutées à la liste de courses.'),
        msg('ms-6', -1, 9, 40, paul, 'Vu avec la pharmacie : le renouvellement sera prêt jeudi.'),
        msg('ms-7', 0, 8, 35, marie, 'Nadia est passée ce matin, tout va bien. Le moral remonte depuis la visite de Paul.'),
        msg('ms-dm-1', -2, 21, 0, paul, 'Pour l\'anniversaire de maman, on part sur le restaurant du parc ?', 'dm', 'u-marie'),
        msg('ms-dm-2', -2, 21, 12, marie, 'Oui, parfait. Je réserve pour midi, c\'est le moment où elle est en forme.', 'dm', 'u-paul'),
    ];

    // ── Documents (2 fichiers factices, data URLs 1x1) ───────────────────────
    const documents = [
        {
            id: 'doc-1', circle_id: 'c-jeanne', title: 'Ordonnance Dr Martin', category: 'prescription',
            file_path: TINY_PNG, mime_type: 'image/png', size_bytes: 95, uploaded_by: 'u-marie',
            uploaded_by_name: 'Marie Dupont', notes: 'Traitement de fond, valable 3 mois', created_at: at(-20, 14, 0),
        },
        {
            id: 'doc-2', circle_id: 'c-jeanne', title: 'Compte-rendu cardiologue (contrôle annuel)', category: 'report',
            file_path: TINY_PNG, mime_type: 'image/png', size_bytes: 95, uploaded_by: 'u-paul',
            uploaded_by_name: 'Paul Dupont', notes: null, created_at: at(-90, 10, 0),
        },
    ];

    // ── Contacts du cercle ────────────────────────────────────────────────────
    const contacts = [
        { id: 'ct-1', circle_id: 'c-jeanne', name: 'Dr Martin', category: 'doctor', organization: 'Cabinet médical des Lilas', phone: '04 78 56 78 90', phone2: null, email: null, address: '3 rue des Lilas, 69003 Lyon', has_key: false, notes: 'Médecin traitant. Visites à domicile le jeudi.', created_at: dstr(-200) },
        { id: 'ct-2', circle_id: 'c-jeanne', name: 'Camille Roux', category: 'nurse', organization: 'Cabinet infirmier des Lilas', phone: '06 12 34 56 78', phone2: null, email: null, address: null, has_key: false, notes: 'Passe le lundi et le jeudi matin (pilulier, tension).', created_at: dstr(-180) },
        { id: 'ct-3', circle_id: 'c-jeanne', name: 'Pharmacie du Parc', category: 'pharmacy', organization: null, phone: '04 78 24 12 12', phone2: null, email: null, address: '12 avenue du Parc, 69003 Lyon', has_key: false, notes: 'Livraison à domicile possible.', created_at: dstr(-180) },
        { id: 'ct-4', circle_id: 'c-jeanne', name: 'Mme Bernard (voisine)', category: 'neighbor', organization: null, phone: '06 98 76 54 32', phone2: null, email: null, address: 'Appartement 12, même immeuble', has_key: true, notes: 'A le double des clés. Passe dire bonjour presque tous les jours.', created_at: dstr(-150) },
        { id: 'ct-5', circle_id: 'c-jeanne', name: 'Nadia Belkacem', category: 'aide', organization: 'CESU', phone: '07 11 22 33 44', phone2: null, email: null, address: null, has_key: true, notes: 'Auxiliaire de vie, du lundi au samedi matin.', created_at: dstr(-120) },
    ];

    // ── Frais partagés sur 2 mois : Marie avance plus que Paul ───────────────
    const expense = (id: string, offset: number, paidBy: Json, amount: number, category: string, description: string): Json => ({
        id, circle_id: 'c-jeanne', paid_by: paidBy.id === 'u-marie' ? cmMarie.id : cmPaul.id,
        paid_by_name: paidBy.name, amount, category, description, date: dstr(offset),
        document_id: null, split_mode: 'equal', splits: equalSplits(amount, sharingIds), created_at: dstr(offset),
    });

    const expenses = [
        expense('ex-1', -2, paul, 67.30, 'food', 'Courses de la semaine'),
        expense('ex-2', -8, marie, 42.80, 'pharmacy', 'Pharmacie : renouvellement du traitement'),
        expense('ex-3', -12, marie, 320.00, 'aide', 'Auxiliaire de vie (CESU), mois en cours'),
        expense('ex-4', -20, marie, 89.90, 'equipment', 'Barre d\'appui pour la salle de bain'),
        expense('ex-5', -35, paul, 24.50, 'transport', 'Taxi médical (contrôle cardiologue)'),
        expense('ex-6', -42, marie, 18.60, 'pharmacy', 'Vitamine D et pansements'),
        expense('ex-7', -43, marie, 320.00, 'aide', 'Auxiliaire de vie (CESU), mois dernier'),
    ];

    const settlements = [
        {
            id: 'st-1', circle_id: 'c-jeanne', from_member: cmPaul.id, to_member: cmMarie.id,
            from_member_name: 'Paul Dupont', to_member_name: 'Marie Dupont',
            amount: 100, date: dstr(-25), note: 'Virement : remboursement partiel', created_at: dstr(-25),
        },
    ];

    const aids = [
        {
            id: 'aid-1', circle_id: 'c-jeanne', type: 'apa', label: 'APA : Métropole de Lyon', amount: 645.40,
            period_start: isoDate(new Date(y, now.getMonth(), 1)), period_end: null,
            notes: 'Versée le 5 de chaque mois sur le compte de Jeanne.', created_at: dstr(-40),
        },
        {
            id: 'aid-2', circle_id: 'c-jeanne', type: 'tax_credit', label: 'Crédit d\'impôt emploi à domicile', amount: 160,
            period_start: isoDate(new Date(y, now.getMonth() - 1, 1)), period_end: null,
            notes: 'Avance immédiate URSSAF sur le CESU de Nadia.', created_at: dstr(-70),
        },
    ];

    return {
        user: { ...marie },
        users: [marie, paul],
        notifications: [
            {
                id: 'n-1', user_id: 'u-marie', circle_id: 'c-jeanne', title: 'Prise manquée',
                message: 'Kardégic 75 mg n\'a pas été confirmé ce matin (8h00).',
                type: 'medication', related_id: 'med-karde', url: '/medications', is_read: false, created_at: at(0, 12, 5),
            },
            {
                id: 'n-2', user_id: 'u-marie', circle_id: 'c-jeanne', title: 'Nouveau frais',
                message: 'Paul a ajouté un frais : Courses de la semaine (67,30 EUR).',
                type: 'expense', related_id: 'ex-1', url: '/expenses', is_read: false, created_at: at(-2, 13, 0),
            },
            {
                id: 'n-3', user_id: 'u-marie', circle_id: 'c-jeanne', title: 'Synthèse hebdomadaire',
                message: 'La synthèse de la semaine dernière est disponible.',
                type: 'digest', related_id: null, url: '/circle', is_read: true, created_at: at(mondayOffset, 8, 0),
            },
        ],
        calendarToken: 'demo-ical-token',
        circles: [
            {
                id: 'c-jeanne',
                name: 'Jeanne',
                currency: 'EUR',
                settings: {},
                created_at: dstr(-200),
                role: 'admin',
                color: '#2563EB',
                recipient: {
                    id: 'r-jeanne', circle_id: 'c-jeanne', first_name: 'Jeanne', last_name: 'Dupont',
                    birth_date: `${y - 87}-03-12`, photo_url: null,
                    address: '14 rue des Lilas, 69003 Lyon', phone: '04 78 12 34 56',
                    blood_type: 'A+', allergies: 'Pénicilline',
                    medical_history: 'Hypertension artérielle traitée, arthrose des genoux, opération de la cataracte (2022).',
                    mobility_notes: 'Se déplace avec une canne. Les escaliers sont difficiles, ascenseur indispensable.',
                    diet_notes: 'Régime pauvre en sel. Aime la soupe le soir et le café au lait le matin.',
                    social_security_number: '2 39 03 69 123 456 78',
                    insurance_info: 'Mutuelle Santé Plus, contrat n° 482 393',
                    advance_directives: 'Directives anticipées déposées chez Me Blanc (notaire). Personne de confiance : Marie Dupont.',
                    gp_name: 'Dr Martin', gp_phone: '04 78 56 78 90',
                    notes: 'Préfère qu\'on sonne deux fois pour la prévenir. Sieste entre 13h et 14h30.',
                    created_at: dstr(-200), updated_at: dstr(-5),
                },
                members: [cmMarie, cmPaul],
                invites: [
                    {
                        id: 'inv-1', circle_id: 'c-jeanne', token: 'demo-invite-sophie', invitee_email: 'sophie@exemple.fr',
                        role: 'family', status: 'pending', expires_at: at(6, 23, 59), created_at: at(-1, 10, 0),
                        created_by_name: 'Marie Dupont',
                    },
                    {
                        id: 'inv-2', circle_id: 'c-jeanne', token: 'demo-invite-kine', invitee_email: 'cabinet.kine@exemple.fr',
                        role: 'professional', status: 'pending', expires_at: at(13, 23, 59), created_at: at(-3, 16, 0),
                        created_by_name: 'Marie Dupont',
                    },
                ],
                caregiverLinks: [
                    {
                        id: 'cl-nadia', circle_id: 'c-jeanne', token: 'demo-lien-nadia', display_name: 'Nadia',
                        role_label: 'Auxiliaire de vie', created_by: 'u-marie', created_by_name: 'Marie Dupont',
                        revoked: false, expires_at: null, last_used_at: at(0, 8, 10), created_at: dstr(-120),
                        status: 'active',
                    },
                ],
                journal,
                vitals,
                medications,
                intakeOverrides,
                prescriptions: [
                    {
                        id: 'rx-1', circle_id: 'c-jeanne', title: 'Ordonnance traitement de fond',
                        prescribed_by: 'Dr Martin', issued_date: dstr(-20), renewal_date: dstr(70),
                        reminder_days: 7, document_id: 'doc-1', notes: 'Renouvelable 2 fois.', created_at: dstr(-20),
                    },
                ],
                events,
                tasks,
                shopping,
                messages,
                documents,
                contacts,
                expenses,
                settlements,
                aids,
                notes: [
                    { id: 'no-1', circle_id: 'c-jeanne', author_name: 'Marie Dupont', content: 'La clé de secours est chez Mme Bernard (appartement 12).', color: 'yellow', expires_at: null, created_at: at(-8, 9, 0) },
                    { id: 'no-2', circle_id: 'c-jeanne', author_name: 'Paul Dupont', content: 'Samedi : je répare le robinet et j\'installe la barre d\'appui.', color: 'blue', expires_at: null, created_at: at(-2, 12, 30) },
                ],
                story: {
                    id: 'story-jeanne', circle_id: 'c-jeanne',
                    sections: [
                        { key: 'metier', title: 'Mon métier', content: 'Institutrice pendant 37 ans à l\'école Jules Ferry de Villeurbanne. Elle adore raconter ses années de classe et reconnaît parfois d\'anciens élèves au marché.' },
                        { key: 'fiertes', title: 'Mes fiertés', content: 'Ses deux enfants, Marie et Paul, et ses quatre petits-enfants. Le potager de la maison de Saint-Genis, qui gagnait le concours du quartier.' },
                        { key: 'habitudes', title: 'Mes habitudes', content: 'Café au lait le matin en écoutant la radio (France Bleu). Mots croisés après le déjeuner, sieste de 13h à 14h30, soupe le soir.' },
                        { key: 'apaise', title: 'Ce qui m\'apaise', content: 'Écouter Georges Brassens, parler du jardin, regarder les photos de famille. Si elle est inquiète, lui proposer un café au lait et parler de l\'école.' },
                        { key: 'musiques', title: 'Mes musiques', content: 'Georges Brassens (« La chanson pour l\'Auvergnat »), Barbara, Jacques Brel. Le CD est à côté du poste, elle aime chanter avec.' },
                    ],
                    updated_by: 'u-marie', updated_at: dstr(-15), created_at: dstr(-120),
                },
                emergencySheet: {
                    id: 'es-jeanne', circle_id: 'c-jeanne', public_token: 'demo-urgence-jeanne',
                    enabled: true,
                    extra_notes: 'Clé de secours chez Mme Bernard, appartement 12 (06 98 76 54 32). Jeanne porte un bracelet de téléassistance.',
                    updated_at: dstr(-5), created_at: dstr(-100),
                },
                digests: [
                    {
                        id: 'dg-1', circle_id: 'c-jeanne', week_start: dstr(mondayOffset - 7),
                        content: 'Semaine globalement sereine pour Jeanne. 6 passages de Nadia, 2 visites de Marie et 1 visite de Paul. Le moral est resté stable, avec un creux mardi (elle a beaucoup parlé de son mari).\n\nPoint de vigilance : une glissade dans la cuisine, sans chute ni blessure. Le tapis antidérapant a été remis et Paul installe une barre d\'appui ce week-end.\n\nSanté : tension stable autour de 13,8/8,2, poids constant à 58,2 kg. Une prise de Kardégic oubliée dans la semaine.\n\nÀ venir : rendez-vous cardiologue avec le Dr Lefèvre, taxi médical réservé par Paul.',
                        created_at: at(mondayOffset, 8, 0),
                    },
                ],
                presenceSignals: [
                    { id: 'ps-1', circle_id: 'c-jeanne', source: 'Cuisine : cafetière', kind: 'power', payload: {}, occurred_at: at(0, 7, 42) },
                    { id: 'ps-2', circle_id: 'c-jeanne', source: 'Couloir : détecteur de mouvement', kind: 'motion', payload: {}, occurred_at: at(0, 7, 31) },
                    { id: 'ps-3', circle_id: 'c-jeanne', source: 'Porte d\'entrée', kind: 'door', payload: {}, occurred_at: at(0, 8, 12) },
                    { id: 'ps-4', circle_id: 'c-jeanne', source: 'Salon : détecteur de mouvement', kind: 'motion', payload: {}, occurred_at: at(0, 9, 5) },
                    { id: 'ps-5', circle_id: 'c-jeanne', source: 'Cuisine : cafetière', kind: 'power', payload: {}, occurred_at: at(-1, 7, 38) },
                    { id: 'ps-6', circle_id: 'c-jeanne', source: 'Porte d\'entrée', kind: 'door', payload: {}, occurred_at: at(-1, 8, 15) },
                ],
                presenceRule: {
                    id: 'pr-1', enabled: true, no_activity_before: '10:00',
                    alert_member_ids: [cmMarie.id, cmPaul.id], last_alert_date: null,
                },
                presenceWebhookUrl: '/api/presence/webhook/c-jeanne/demo-webhook-token',
            },
            // Second cercle minimal : le père, pour montrer le multi-proches.
            {
                id: 'c-papa',
                name: 'Papa',
                currency: 'EUR',
                settings: {},
                created_at: dstr(-90),
                role: 'admin',
                color: '#D97706',
                recipient: {
                    id: 'r-papa', circle_id: 'c-papa', first_name: 'Robert', last_name: 'Dupont',
                    birth_date: `${y - 89}-11-02`, photo_url: null,
                    address: 'Résidence Les Tilleuls, 38200 Vienne', phone: '04 74 11 22 33',
                    blood_type: 'O+', allergies: null,
                    medical_history: 'Diabète de type 2, prothèse de hanche (2019).',
                    mobility_notes: 'Déambulateur pour les sorties.', diet_notes: 'Suivi diabétique par la résidence.',
                    social_security_number: null, insurance_info: null, advance_directives: null,
                    gp_name: 'Dr Petit', gp_phone: '04 74 99 88 77', notes: null,
                    created_at: dstr(-90), updated_at: dstr(-30),
                },
                members: [
                    {
                        id: 'cm-marie-papa', circle_id: 'c-papa', user_id: 'u-marie', role: 'admin', color: '#2563EB',
                        created_at: dstr(-90), name: marie.name, email: marie.email, avatar_url: null,
                    },
                ],
                invites: [],
                caregiverLinks: [],
                journal: [
                    {
                        id: 'jp-1', circle_id: 'c-papa', author_user_id: 'u-marie', caregiver_link_id: null,
                        author_name: 'Marie Dupont', type: 'visit',
                        content: 'Visite à la résidence : papa va bien, il a gagné le tournoi de pétanque des Tilleuls.',
                        data: {}, occurred_at: at(-3, 15, 0), created_at: at(-3, 15, 0), photos: [],
                    },
                    {
                        id: 'jp-2', circle_id: 'c-papa', author_user_id: 'u-marie', caregiver_link_id: null,
                        author_name: 'Marie Dupont', type: 'note',
                        content: 'La résidence demande de renouveler le trousseau (2 pantalons, chaussons).',
                        data: {}, occurred_at: at(-7, 11, 0), created_at: at(-7, 11, 0), photos: [],
                    },
                ],
                vitals: [
                    {
                        id: 'vp-1', circle_id: 'c-papa', type: 'weight', value: 72.4, value2: null, unit: 'kg',
                        measured_at: at(-10, 10, 0), journal_entry_id: null, recorded_by_user: 'u-marie', notes: null,
                        created_at: at(-10, 10, 0),
                    },
                ],
                medications: [],
                intakeOverrides: {},
                prescriptions: [],
                events: [
                    {
                        id: 'evp-1', circle_id: 'c-papa', title: 'Visite de Marie à la résidence',
                        description: null, category: 'visit',
                        start_time: at(3, 14, 30), end_time: at(3, 16, 0), location: 'Résidence Les Tilleuls, Vienne',
                        rrule: null, member_ids: ['cm-marie-papa'], reminder_30min: false, reminder_1hour: false,
                        notes: null, created_by: 'u-marie', created_at: dstr(-5),
                    },
                ],
                tasks: [
                    {
                        id: 'tkp-1', circle_id: 'c-papa', title: 'Acheter le trousseau demandé par la résidence',
                        description: '2 pantalons, des chaussons', category: 'shopping', is_completed: false,
                        due_date: at(4, 12, 0), frequency: null, priority: 'Moyenne',
                        assigned_to: ['cm-marie-papa'], completed_at: null, completed_by: null, created_at: at(-7, 11, 30),
                    },
                ],
                shopping: [],
                messages: [],
                documents: [],
                contacts: [
                    {
                        id: 'ctp-1', circle_id: 'c-papa', name: 'Résidence Les Tilleuls (accueil)', category: 'other',
                        organization: 'Résidence autonomie', phone: '04 74 11 22 33', phone2: null, email: null,
                        address: '8 chemin des Tilleuls, 38200 Vienne', has_key: false,
                        notes: 'Accueil ouvert de 8h à 19h.', created_at: dstr(-90),
                    },
                ],
                expenses: [],
                settlements: [],
                aids: [],
                notes: [],
                story: {
                    id: 'story-papa', circle_id: 'c-papa', sections: [], updated_by: null,
                    updated_at: dstr(-90), created_at: dstr(-90),
                },
                emergencySheet: {
                    id: 'es-papa', circle_id: 'c-papa', public_token: 'demo-urgence-robert',
                    enabled: false, extra_notes: null, updated_at: dstr(-90), created_at: dstr(-90),
                },
                digests: [],
                presenceSignals: [],
                presenceRule: null,
                presenceWebhookUrl: null,
            },
        ],
    };
}
