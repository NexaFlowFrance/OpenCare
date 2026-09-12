import type { Request } from 'express';

/**
 * Langue des messages produits par le serveur (erreurs de validation, tests
 * de connexion des integrations, garde-fou URL...). Le client affiche ces
 * messages tels quels dans ses toasts : ils doivent donc suivre la langue de
 * l'utilisateur, et non rester en francais.
 */
export type Lang = 'fr' | 'en';

/** 'en' pour toute valeur commencant par "en" (en, en-US, EN...), 'fr' sinon. */
export function pickLang(value: unknown): Lang {
    return typeof value === 'string' && /^en/i.test(value.trim()) ? 'en' : 'fr';
}

/**
 * Resout la langue d'une requete, par priorite :
 * 1. premier tag de l'en-tete Accept-Language (envoye par le client avec la
 *    langue courante de l'interface, ou par le navigateur sur les routes publiques) ;
 * 2. req.language, pose par authMiddleware depuis la colonne users.language ;
 * 3. francais.
 */
export function langFromRequest(req: Request & { language?: string }): Lang {
    const header = req.headers['accept-language'];
    const raw = Array.isArray(header) ? header[0] : header;
    const firstTag = typeof raw === 'string' ? raw.split(',')[0]?.split(';')[0]?.trim() : '';
    if (firstTag) return pickLang(firstTag);
    if (req.language) return pickLang(req.language);
    return 'fr';
}

// Les textes francais reprennent mot pour mot les anciens litteraux des routes
// (aucun changement pour les utilisateurs francophones).
const MESSAGES: Record<Lang, Record<string, string>> = {
    fr: {
        'url.invalid': 'URL invalide',
        'url.protocol': 'Seuls les protocoles http et https sont autorisés',
        'url.ws_invalid': 'URL WebSocket invalide',
        'url.ws_protocol': 'Seuls les protocoles ws et wss sont autorisés',
        'url.cloud_metadata': 'Cette adresse est bloquée (service de métadonnées cloud)',
        'url.blocked': 'Cette adresse est bloquée ({{reason}})',
        'url.private': 'Cette adresse est bloquée (private address)',
        'url.dns': 'Résolution DNS impossible pour cet hôte',
        'url.no_ip': 'Aucune adresse IP pour cet hôte',
        'url.redirect': 'SSRF_REDIRECT_BLOCKED: redirection vers un hôte différent refusée',
        'url.redirect_invalid': 'SSRF_REDIRECT_BLOCKED: Location de redirection invalide',
        'url.too_many_redirects': 'SSRF_REDIRECT_BLOCKED: trop de redirections',

        'ai.AI_UNREACHABLE': 'Impossible de joindre le fournisseur IA',
        'ai.AI_UNAUTHORIZED': 'Clé API refusée par le fournisseur IA',
        'ai.AI_MODEL_NOT_FOUND': 'Modèle introuvable chez le fournisseur IA',
        'ai.AI_INVALID_RESPONSE': 'Le modèle a renvoyé une réponse invalide',
        'ai.AI_PROVIDER_ERROR': 'Le fournisseur IA a renvoyé une erreur',
        'ai.AI_NOT_CONFIGURED': "L'assistant IA n'est pas configuré",
        'ai.testNotJson': 'Le modèle a répondu, mais pas le JSON attendu',
        'ai.modelRequired': 'model est requis',

        'medications.schedulesArray': 'schedules doit être un tableau',
        'medications.scheduleInvalid': 'Horaire de prise invalide',
        'medications.timeInvalid': 'Heure de prise invalide (format HH:MM attendu)',
        'medications.daysInvalid': 'Jours de prise invalides (entiers de 1 à 7 attendus)',
        'medications.photoDataUrl': 'photo_url doit être une data URL image',
        'medications.photoTooLarge': 'Photo trop volumineuse (1.5 Mo maximum)',
        'medications.dateFormat': '{{field}} doit être une date au format YYYY-MM-DD',
        'medications.statusInvalid': 'Statut invalide',
        'medications.intakeNotFound': 'Prise introuvable',
        'medications.activeParam': 'Paramètre active invalide (true, false ou all)',
        'medications.nameRequired': 'Le nom du médicament est requis',
        'medications.activeBoolean': 'active doit être un booléen',
        'medications.notFound': 'Médicament introuvable',
        'medications.datesInvalid': 'Dates invalides (format YYYY-MM-DD attendu)',
        'medications.endBeforeStart': 'La date de fin doit suivre la date de début',
        'medications.prescriptionTitleRequired': "Le titre de l'ordonnance est requis",
        'medications.reminderDays': 'reminder_days doit être un entier positif',
        'medications.prescriptionNotFound': 'Ordonnance introuvable',
        'medications.quantityInvalid': 'Quantité par prise invalide (entre 0,25 et 99)',
        'medications.unitInvalid': 'Unité de prise invalide',
        'medications.prnBoolean': 'prn doit être un booléen',
        'medications.withFoodInvalid': 'with_food invalide (with, without ou any)',

        'expenses.splitsRequired': 'splits est requis pour une répartition personnalisée',
        'expenses.splitsInvalidMember': 'splits contient un membre invalide',
        'expenses.splitsDuplicateMember': 'splits contient un membre en double',
        'expenses.sharePositive': 'Chaque part doit être un montant positif',
        'expenses.sharesSum': 'La somme des parts doit être égale au montant',
        'expenses.amountPositive': 'Le montant doit être supérieur à zéro',
        'expenses.categoryInvalid': 'Catégorie invalide',
        'expenses.dateInvalid': 'Date invalide (format AAAA-MM-JJ)',
        'expenses.fieldDateInvalid': '{{field}} invalide (format AAAA-MM-JJ)',
        'expenses.splitModeInvalid': 'split_mode invalide',
        'expenses.payerInvalid': 'Payeur invalide',
        'expenses.receiptInvalid': 'Justificatif invalide',
        'expenses.notFound': 'Frais introuvable',
        'expenses.onlyAuthorEdit': "Seul l'auteur du frais ou un admin peut le modifier",
        'expenses.onlyAuthorDelete': "Seul l'auteur du frais ou un admin peut le supprimer",
        'expenses.membersInvalid': 'Membres invalides',
        'expenses.settlementNotFound': 'Règlement introuvable',
        'expenses.onlySettlementAuthorDelete': "Seul l'auteur du règlement ou un admin peut le supprimer",
        'expenses.aidTypeInvalid': "Type d'aide invalide",
        'expenses.aidNotFound': 'Aide introuvable',

        'circles.recipientFirstNameRequired': 'Le prénom du proche est requis',
        'circles.mustAdminLinked': 'Vous devez être administrateur du cercle à lier',
        'circles.targetInvalid': 'Cercle cible invalide',
        'circles.mustAdminBoth': 'Vous devez être administrateur des deux cercles',
        'circles.alreadyInHousehold': 'Un des cercles appartient déjà à un autre foyer',
        'circles.notInHousehold': "Ce cercle ne fait pas partie d'un foyer",
        'circles.keepOneAdmin': 'Le cercle doit garder au moins un administrateur',
        'circles.firstNameRequired': 'Le prénom est requis',

        'invites.invalidOrExpired': 'Invitation invalide ou expirée',
        'invites.reservedForOtherEmail': 'Cette invitation est réservée à une autre adresse e-mail',
        'invites.alreadyMember': 'Vous êtes déjà membre de ce cercle',

        'auth.imageTooLarge': 'Image trop volumineuse',
        'handover.notFound': 'Pack introuvable',
        'handover.expired': 'Ce pack de relais a expiré',
        'emergency.notFound': 'Fiche introuvable',

        'integrations.typeAndUrlRequired': 'type et base_url sont requis',
        'integrations.unknownType': "Type d'integration inconnu",
        'integrations.unknownError': 'Erreur inconnue',
        'integrations.notFound': 'Integration introuvable',
        'integrations.unreachable': 'Impossible de joindre le serveur',
        'integrations.httpError': 'Erreur HTTP {{status}}',
        'integrations.immichNotConfigured': 'Aucune integration Immich configuree',
        'integrations.immichUnavailable': 'Immich indisponible',
        'integrations.whisperKeyInvalid': 'Clé API Whisper invalide',
        'integrations.whisperStatus': 'Le service Whisper a répondu {{status}}',
        'integrations.whisperOk': 'Connexion au service Whisper réussie',
        'integrations.whisperTimeout': 'Le service Whisper ne répond pas (10s)',
        'integrations.whisperUnreachable': 'Service Whisper injoignable',
        'integrations.ha.tokenInvalid': 'Token invalide ou expiré',
        'integrations.ha.shoppingList': 'Connecté a Home Assistant (integration shopping_list détectée)',
        'integrations.ha.todo': 'Connecté a Home Assistant (todo entity détectée, {{count}} element{{s}})',
        'integrations.ha.none': 'Connecté a Home Assistant. Ni "shopping_list" ni "todo.shopping_list" détecté. Vérifiez que l\'une de ces intégrations est activée, ou renseignez l\'identifiant de votre entité todo.',
        'integrations.ha.wsTimeout': 'Timeout connexion WebSocket Home Assistant',
        'integrations.ha.wsTokenInvalid': 'Token Home Assistant invalide',
        'integrations.ha.entityNotFound': 'Entité "{{entityId}}" introuvable dans Home Assistant',
        'integrations.ha.wsError': 'Impossible de se connecter au WebSocket HA : {{detail}}',
        'integrations.ha.tokenMissing': 'Token manquant',
        'integrations.nextcloud.serverUnreachable': 'Serveur inaccessible (HTTP {{status}})',
        'integrations.nextcloud.badCredentials': 'Identifiants incorrects. Si la double authentification est activée, utilisez un App Password.',
        'integrations.nextcloud.userNotFound': 'Utilisateur "{{username}}" introuvable sur ce serveur.',
        'integrations.nextcloud.davError': 'Erreur DAV {{status}}',
        'integrations.nextcloud.connected': 'Connecté a Nextcloud {{version}} : {{count}} calendrier{{s}} trouvé{{s}}',
        'integrations.grocy.connected': 'Connecte a Grocy {{version}}',
        'integrations.immich.keyInvalid': 'Cle API incorrecte',
        'integrations.immich.connected': 'Connecte a Immich {{version}}',

        'voice.whisperTimeout': "Le service Whisper n'a pas répondu en {{seconds}}s",
    },
    en: {
        'url.invalid': 'Invalid URL',
        'url.protocol': 'Only the http and https protocols are allowed',
        'url.ws_invalid': 'Invalid WebSocket URL',
        'url.ws_protocol': 'Only the ws and wss protocols are allowed',
        'url.cloud_metadata': 'This address is blocked (cloud metadata service)',
        'url.blocked': 'This address is blocked ({{reason}})',
        'url.private': 'This address is blocked (private address)',
        'url.dns': 'DNS resolution failed for this host',
        'url.no_ip': 'No IP address found for this host',
        'url.redirect': 'SSRF_REDIRECT_BLOCKED: redirect to a different host refused',
        'url.redirect_invalid': 'SSRF_REDIRECT_BLOCKED: invalid redirect Location',
        'url.too_many_redirects': 'SSRF_REDIRECT_BLOCKED: too many redirects',

        'ai.AI_UNREACHABLE': 'Cannot reach the AI provider',
        'ai.AI_UNAUTHORIZED': 'API key rejected by the AI provider',
        'ai.AI_MODEL_NOT_FOUND': 'Model not found at the AI provider',
        'ai.AI_INVALID_RESPONSE': 'The model returned an invalid response',
        'ai.AI_PROVIDER_ERROR': 'The AI provider returned an error',
        'ai.AI_NOT_CONFIGURED': 'The AI assistant is not configured',
        'ai.testNotJson': 'The model answered, but not with the expected JSON',
        'ai.modelRequired': 'model is required',

        'medications.schedulesArray': 'schedules must be an array',
        'medications.scheduleInvalid': 'Invalid intake schedule',
        'medications.timeInvalid': 'Invalid intake time (HH:MM format expected)',
        'medications.daysInvalid': 'Invalid intake days (integers from 1 to 7 expected)',
        'medications.photoDataUrl': 'photo_url must be an image data URL',
        'medications.photoTooLarge': 'Photo too large (1.5 MB maximum)',
        'medications.dateFormat': '{{field}} must be a date in YYYY-MM-DD format',
        'medications.statusInvalid': 'Invalid status',
        'medications.intakeNotFound': 'Intake not found',
        'medications.activeParam': 'Invalid active parameter (true, false or all)',
        'medications.nameRequired': 'The medication name is required',
        'medications.activeBoolean': 'active must be a boolean',
        'medications.notFound': 'Medication not found',
        'medications.datesInvalid': 'Invalid dates (YYYY-MM-DD format expected)',
        'medications.endBeforeStart': 'The end date must come after the start date',
        'medications.prescriptionTitleRequired': 'The prescription title is required',
        'medications.reminderDays': 'reminder_days must be a positive integer',
        'medications.prescriptionNotFound': 'Prescription not found',
        'medications.quantityInvalid': 'Invalid quantity per dose (between 0.25 and 99)',
        'medications.unitInvalid': 'Invalid dose unit',
        'medications.prnBoolean': 'prn must be a boolean',
        'medications.withFoodInvalid': 'Invalid with_food (with, without or any)',

        'expenses.splitsRequired': 'splits is required for a custom split',
        'expenses.splitsInvalidMember': 'splits contains an invalid member',
        'expenses.splitsDuplicateMember': 'splits contains a duplicate member',
        'expenses.sharePositive': 'Each share must be a positive amount',
        'expenses.sharesSum': 'The shares must add up to the amount',
        'expenses.amountPositive': 'The amount must be greater than zero',
        'expenses.categoryInvalid': 'Invalid category',
        'expenses.dateInvalid': 'Invalid date (YYYY-MM-DD format)',
        'expenses.fieldDateInvalid': 'Invalid {{field}} (YYYY-MM-DD format)',
        'expenses.splitModeInvalid': 'Invalid split_mode',
        'expenses.payerInvalid': 'Invalid payer',
        'expenses.receiptInvalid': 'Invalid receipt',
        'expenses.notFound': 'Expense not found',
        'expenses.onlyAuthorEdit': 'Only the expense author or an admin can edit it',
        'expenses.onlyAuthorDelete': 'Only the expense author or an admin can delete it',
        'expenses.membersInvalid': 'Invalid members',
        'expenses.settlementNotFound': 'Settlement not found',
        'expenses.onlySettlementAuthorDelete': 'Only the settlement author or an admin can delete it',
        'expenses.aidTypeInvalid': 'Invalid aid type',
        'expenses.aidNotFound': 'Aid not found',

        'circles.recipientFirstNameRequired': 'The first name of the person receiving care is required',
        'circles.mustAdminLinked': 'You must be an administrator of the circle to link',
        'circles.targetInvalid': 'Invalid target circle',
        'circles.mustAdminBoth': 'You must be an administrator of both circles',
        'circles.alreadyInHousehold': 'One of the circles already belongs to another household',
        'circles.notInHousehold': 'This circle is not part of a household',
        'circles.keepOneAdmin': 'The circle must keep at least one administrator',
        'circles.firstNameRequired': 'The first name is required',

        'invites.invalidOrExpired': 'Invalid or expired invitation',
        'invites.reservedForOtherEmail': 'This invitation is reserved for another email address',
        'invites.alreadyMember': 'You are already a member of this circle',

        'auth.imageTooLarge': 'Image too large',
        'handover.notFound': 'Handover pack not found',
        'handover.expired': 'This handover pack has expired',
        'emergency.notFound': 'Emergency sheet not found',

        'integrations.typeAndUrlRequired': 'type and base_url are required',
        'integrations.unknownType': 'Unknown integration type',
        'integrations.unknownError': 'Unknown error',
        'integrations.notFound': 'Integration not found',
        'integrations.unreachable': 'Cannot reach the server',
        'integrations.httpError': 'HTTP error {{status}}',
        'integrations.immichNotConfigured': 'No Immich integration configured',
        'integrations.immichUnavailable': 'Immich unavailable',
        'integrations.whisperKeyInvalid': 'Invalid Whisper API key',
        'integrations.whisperStatus': 'The Whisper service answered {{status}}',
        'integrations.whisperOk': 'Connected to the Whisper service',
        'integrations.whisperTimeout': 'The Whisper service is not responding (10s)',
        'integrations.whisperUnreachable': 'Whisper service unreachable',
        'integrations.ha.tokenInvalid': 'Invalid or expired token',
        'integrations.ha.shoppingList': 'Connected to Home Assistant (shopping_list integration detected)',
        'integrations.ha.todo': 'Connected to Home Assistant (todo entity detected, {{count}} item{{s}})',
        'integrations.ha.none': 'Connected to Home Assistant. Neither "shopping_list" nor "todo.shopping_list" was detected. Check that one of these integrations is enabled, or enter the ID of your todo entity.',
        'integrations.ha.wsTimeout': 'Home Assistant WebSocket connection timed out',
        'integrations.ha.wsTokenInvalid': 'Invalid Home Assistant token',
        'integrations.ha.entityNotFound': 'Entity "{{entityId}}" not found in Home Assistant',
        'integrations.ha.wsError': 'Cannot connect to the Home Assistant WebSocket: {{detail}}',
        'integrations.ha.tokenMissing': 'Missing token',
        'integrations.nextcloud.serverUnreachable': 'Server unreachable (HTTP {{status}})',
        'integrations.nextcloud.badCredentials': 'Incorrect credentials. If two-factor authentication is enabled, use an App Password.',
        'integrations.nextcloud.userNotFound': 'User "{{username}}" not found on this server.',
        'integrations.nextcloud.davError': 'DAV error {{status}}',
        'integrations.nextcloud.connected': 'Connected to Nextcloud {{version}}: {{count}} calendar{{s}} found',
        'integrations.grocy.connected': 'Connected to Grocy {{version}}',
        'integrations.immich.keyInvalid': 'Incorrect API key',
        'integrations.immich.connected': 'Connected to Immich {{version}}',

        'voice.whisperTimeout': 'The Whisper service did not answer within {{seconds}}s',
    },
};

/**
 * Traduit une cle (ex. 'medications.nameRequired') dans la langue demandee,
 * avec interpolation des variables {{var}}. Repli sur le francais, puis sur la
 * cle elle-meme, pour ne jamais renvoyer une chaine vide.
 */
export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
    const template = MESSAGES[lang]?.[key] ?? MESSAGES.fr[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
        name in vars ? String(vars[name]) : match
    );
}
