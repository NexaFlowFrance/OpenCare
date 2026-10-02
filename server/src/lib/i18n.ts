import type { Request } from 'express';

/**
 * Langue des messages produits par le serveur (erreurs de validation, tests
 * de connexion des integrations, garde-fou URL...). Le client affiche ces
 * messages tels quels dans ses toasts : ils doivent donc suivre la langue de
 * l'utilisateur, et non rester en francais.
 */
export type Lang = 'fr' | 'en' | 'es';

/** Les langues de l'interface, dans l'ordre ou le client les propose. */
export const LANGS: readonly Lang[] = ['fr', 'en', 'es'];

/**
 * 'en' ou 'es' pour toute valeur qui commence ainsi (en-US, ES, es-419...),
 * 'fr' sinon : le francais reste la langue par defaut du projet.
 */
export function pickLang(value: unknown): Lang {
    if (typeof value !== 'string') return 'fr';
    const tag = value.trim().toLowerCase();
    if (tag.startsWith('en')) return 'en';
    if (tag.startsWith('es')) return 'es';
    return 'fr';
}

/**
 * Le texte d'une langue, pour les phrases construites dans le code (notifications,
 * reponses du compagnon...) plutot que dans MESSAGES. Le type impose les trois
 * variantes : une langue ajoutee plus tard fera echouer la compilation a chaque
 * phrase oubliee, au lieu de tomber en silence sur le francais.
 */
export function pick<T>(lang: Lang, variants: Record<Lang, T>): T {
    return variants[lang];
}

/** Locale Intl d'une langue, pour les nombres et les dates produits par le serveur. */
export function intlLocale(lang: Lang): string {
    return pick(lang, { fr: 'fr-FR', en: 'en-US', es: 'es-ES' });
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
// Exporte pour le test de parite (tests/server/i18n.test.ts) : une cle absente
// d'une langue retomberait en silence sur le francais.
export const MESSAGES: Record<Lang, Record<string, string>> = {
    fr: {
        'events.not_recurring': "Cet événement ne se répète pas : modifiez-le directement.",
        'medications.stockInvalid': 'Quantité de stock invalide.',
        'medications.stockRequired': 'Indiquez un stock ou un seuil.',
        'vitals.thresholdInvalid': 'Seuil invalide : le minimum doit être inférieur au maximum.',
        'vitals.thresholdType': 'Type de constante inconnu.',
        'events.no_occurrence': "Aucune occurrence à cette date.",
        'events.move_too_far': 'Une occurrence ne peut être déplacée que de {{days}} jours au maximum.',
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
        'events.not_recurring': 'This event does not repeat: edit it directly.',
        'medications.stockInvalid': 'Invalid stock quantity.',
        'medications.stockRequired': 'Provide a stock or a threshold.',
        'vitals.thresholdInvalid': 'Invalid threshold: the minimum must be below the maximum.',
        'vitals.thresholdType': 'Unknown vital type.',
        'events.no_occurrence': 'No occurrence on that date.',
        'events.move_too_far': 'An occurrence can only be moved by up to {{days}} days.',
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
    // Espagnol : vouvoiement cote aidants, comme l'interface (client/src/i18n/locales/es).
    es: {
        'events.not_recurring': 'Este evento no se repite: modifíquelo directamente.',
        'medications.stockInvalid': 'Cantidad de stock no válida.',
        'medications.stockRequired': 'Indique un stock o un umbral.',
        'vitals.thresholdInvalid': 'Umbral no válido: el mínimo debe ser inferior al máximo.',
        'vitals.thresholdType': 'Tipo de constante desconocido.',
        'events.no_occurrence': 'No hay ninguna repetición en esa fecha.',
        'events.move_too_far': 'Una repetición solo puede moverse {{days}} días como máximo.',
        'url.invalid': 'URL no válida',
        'url.protocol': 'Solo se permiten los protocolos http y https',
        'url.ws_invalid': 'URL de WebSocket no válida',
        'url.ws_protocol': 'Solo se permiten los protocolos ws y wss',
        'url.cloud_metadata': 'Esta dirección está bloqueada (servicio de metadatos en la nube)',
        'url.blocked': 'Esta dirección está bloqueada ({{reason}})',
        'url.private': 'Esta dirección está bloqueada (dirección privada)',
        'url.dns': 'No se pudo resolver el DNS de este host',
        'url.no_ip': 'No se encontró ninguna dirección IP para este host',
        'url.redirect': 'SSRF_REDIRECT_BLOCKED: redirección a otro host rechazada',
        'url.redirect_invalid': 'SSRF_REDIRECT_BLOCKED: Location de redirección no válida',
        'url.too_many_redirects': 'SSRF_REDIRECT_BLOCKED: demasiadas redirecciones',

        'ai.AI_UNREACHABLE': 'No se puede contactar con el proveedor de IA',
        'ai.AI_UNAUTHORIZED': 'El proveedor de IA ha rechazado la clave API',
        'ai.AI_MODEL_NOT_FOUND': 'Modelo no encontrado en el proveedor de IA',
        'ai.AI_INVALID_RESPONSE': 'El modelo ha devuelto una respuesta no válida',
        'ai.AI_PROVIDER_ERROR': 'El proveedor de IA ha devuelto un error',
        'ai.AI_NOT_CONFIGURED': 'El asistente de IA no está configurado',
        'ai.testNotJson': 'El modelo ha respondido, pero no con el JSON esperado',
        'ai.modelRequired': 'model es obligatorio',

        'medications.schedulesArray': 'schedules debe ser una lista',
        'medications.scheduleInvalid': 'Horario de toma no válido',
        'medications.timeInvalid': 'Hora de toma no válida (formato HH:MM esperado)',
        'medications.daysInvalid': 'Días de toma no válidos (enteros del 1 al 7 esperados)',
        'medications.photoDataUrl': 'photo_url debe ser una data URL de imagen',
        'medications.photoTooLarge': 'Foto demasiado grande (1,5 MB como máximo)',
        'medications.dateFormat': '{{field}} debe ser una fecha con formato AAAA-MM-DD',
        'medications.statusInvalid': 'Estado no válido',
        'medications.intakeNotFound': 'Toma no encontrada',
        'medications.activeParam': 'Parámetro active no válido (true, false o all)',
        'medications.nameRequired': 'El nombre del medicamento es obligatorio',
        'medications.activeBoolean': 'active debe ser un booleano',
        'medications.notFound': 'Medicamento no encontrado',
        'medications.datesInvalid': 'Fechas no válidas (formato AAAA-MM-DD esperado)',
        'medications.endBeforeStart': 'La fecha de fin debe ser posterior a la de inicio',
        'medications.prescriptionTitleRequired': 'El título de la receta es obligatorio',
        'medications.reminderDays': 'reminder_days debe ser un entero positivo',
        'medications.prescriptionNotFound': 'Receta no encontrada',
        'medications.quantityInvalid': 'Cantidad por toma no válida (entre 0,25 y 99)',
        'medications.unitInvalid': 'Unidad de toma no válida',
        'medications.prnBoolean': 'prn debe ser un booleano',
        'medications.withFoodInvalid': 'with_food no válido (with, without o any)',

        'expenses.splitsRequired': 'splits es obligatorio para un reparto personalizado',
        'expenses.splitsInvalidMember': 'splits contiene un miembro no válido',
        'expenses.splitsDuplicateMember': 'splits contiene un miembro duplicado',
        'expenses.sharePositive': 'Cada parte debe ser un importe positivo',
        'expenses.sharesSum': 'La suma de las partes debe ser igual al importe',
        'expenses.amountPositive': 'El importe debe ser mayor que cero',
        'expenses.categoryInvalid': 'Categoría no válida',
        'expenses.dateInvalid': 'Fecha no válida (formato AAAA-MM-DD)',
        'expenses.fieldDateInvalid': '{{field}} no válido (formato AAAA-MM-DD)',
        'expenses.splitModeInvalid': 'split_mode no válido',
        'expenses.payerInvalid': 'Pagador no válido',
        'expenses.receiptInvalid': 'Justificante no válido',
        'expenses.notFound': 'Gasto no encontrado',
        'expenses.onlyAuthorEdit': 'Solo el autor del gasto o un administrador puede modificarlo',
        'expenses.onlyAuthorDelete': 'Solo el autor del gasto o un administrador puede eliminarlo',
        'expenses.membersInvalid': 'Miembros no válidos',
        'expenses.settlementNotFound': 'Pago no encontrado',
        'expenses.onlySettlementAuthorDelete': 'Solo el autor del pago o un administrador puede eliminarlo',
        'expenses.aidTypeInvalid': 'Tipo de ayuda no válido',
        'expenses.aidNotFound': 'Ayuda no encontrada',

        'circles.recipientFirstNameRequired': 'El nombre de su familiar es obligatorio',
        'circles.mustAdminLinked': 'Debe ser administrador del círculo que quiere vincular',
        'circles.targetInvalid': 'Círculo de destino no válido',
        'circles.mustAdminBoth': 'Debe ser administrador de los dos círculos',
        'circles.alreadyInHousehold': 'Uno de los círculos ya pertenece a otro hogar',
        'circles.notInHousehold': 'Este círculo no forma parte de un hogar',
        'circles.keepOneAdmin': 'El círculo debe conservar al menos un administrador',
        'circles.firstNameRequired': 'El nombre es obligatorio',

        'invites.invalidOrExpired': 'Invitación no válida o caducada',
        'invites.reservedForOtherEmail': 'Esta invitación está reservada a otra dirección de correo',
        'invites.alreadyMember': 'Ya es miembro de este círculo',

        'auth.imageTooLarge': 'Imagen demasiado grande',
        'handover.notFound': 'Paquete de relevo no encontrado',
        'handover.expired': 'Este paquete de relevo ha caducado',
        'emergency.notFound': 'Ficha no encontrada',

        'integrations.typeAndUrlRequired': 'type y base_url son obligatorios',
        'integrations.unknownType': 'Tipo de integración desconocido',
        'integrations.unknownError': 'Error desconocido',
        'integrations.notFound': 'Integración no encontrada',
        'integrations.unreachable': 'No se puede contactar con el servidor',
        'integrations.httpError': 'Error HTTP {{status}}',
        'integrations.immichNotConfigured': 'No hay ninguna integración de Immich configurada',
        'integrations.immichUnavailable': 'Immich no disponible',
        'integrations.whisperKeyInvalid': 'Clave API de Whisper no válida',
        'integrations.whisperStatus': 'El servicio Whisper ha respondido {{status}}',
        'integrations.whisperOk': 'Conexión con el servicio Whisper correcta',
        'integrations.whisperTimeout': 'El servicio Whisper no responde (10 s)',
        'integrations.whisperUnreachable': 'Servicio Whisper inaccesible',
        'integrations.ha.tokenInvalid': 'Token no válido o caducado',
        'integrations.ha.shoppingList': 'Conectado a Home Assistant (integración shopping_list detectada)',
        'integrations.ha.todo': 'Conectado a Home Assistant (entidad todo detectada, {{count}} elemento{{s}})',
        'integrations.ha.none': 'Conectado a Home Assistant. No se ha detectado ni "shopping_list" ni "todo.shopping_list". Compruebe que una de estas integraciones está activada o indique el identificador de su entidad todo.',
        'integrations.ha.wsTimeout': 'Tiempo de espera agotado en la conexión WebSocket de Home Assistant',
        'integrations.ha.wsTokenInvalid': 'Token de Home Assistant no válido',
        'integrations.ha.entityNotFound': 'Entidad "{{entityId}}" no encontrada en Home Assistant',
        'integrations.ha.wsError': 'No se puede conectar al WebSocket de Home Assistant: {{detail}}',
        'integrations.ha.tokenMissing': 'Falta el token',
        'integrations.nextcloud.serverUnreachable': 'Servidor inaccesible (HTTP {{status}})',
        'integrations.nextcloud.badCredentials': 'Credenciales incorrectas. Si la verificación en dos pasos está activada, use una contraseña de aplicación.',
        'integrations.nextcloud.userNotFound': 'Usuario "{{username}}" no encontrado en este servidor.',
        'integrations.nextcloud.davError': 'Error DAV {{status}}',
        'integrations.nextcloud.connected': 'Conectado a Nextcloud {{version}}: {{count}} calendario{{s}} encontrado{{s}}',
        'integrations.grocy.connected': 'Conectado a Grocy {{version}}',
        'integrations.immich.keyInvalid': 'Clave API incorrecta',
        'integrations.immich.connected': 'Conectado a Immich {{version}}',

        'voice.whisperTimeout': 'El servicio Whisper no ha respondido en {{seconds}} s',
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
