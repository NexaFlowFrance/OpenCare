// Roles d'un membre dans un cercle de soin
export const CIRCLE_ROLES = ['admin', 'family', 'professional', 'neighbor', 'viewer'] as const;
export type CircleRole = typeof CIRCLE_ROLES[number];

// Types d'entree du journal de liaison
export const JOURNAL_ENTRY_TYPES = ['visit', 'note', 'vital', 'medication', 'incident', 'mood'] as const;
export type JournalEntryType = typeof JOURNAL_ENTRY_TYPES[number];

// Types de constantes de sante
export const VITAL_TYPES = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'] as const;
export type VitalType = typeof VITAL_TYPES[number];

// Statuts d'une prise de medicament
export const INTAKE_STATUSES = ['pending', 'taken', 'skipped', 'missed'] as const;
export type IntakeStatus = typeof INTAKE_STATUSES[number];

// Formes galeniques (la colonne reste un texte libre : anciennes valeurs tolerees)
export const MEDICATION_FORMS = ['tablet', 'capsule', 'syrup', 'drops', 'patch', 'injection', 'sachet', 'inhaler', 'cream', 'other'] as const;
export type MedicationForm = typeof MEDICATION_FORMS[number];

// Unites de la quantite par prise ("2 comprimes", "5 ml", "1 bouffee")
export const MEDICATION_UNITS = ['tablet', 'capsule', 'ml', 'drop', 'sachet', 'patch', 'injection', 'puff', 'application', 'dose'] as const;
export type MedicationUnit = typeof MEDICATION_UNITS[number];

// Unite par defaut deduite de la forme quand l'horaire n'en precise pas
export const DEFAULT_UNIT_BY_FORM: Record<MedicationForm, MedicationUnit> = {
    tablet: 'tablet',
    capsule: 'capsule',
    syrup: 'ml',
    drops: 'drop',
    patch: 'patch',
    injection: 'injection',
    sachet: 'sachet',
    inhaler: 'puff',
    cream: 'application',
    other: 'dose',
};

// Prise par rapport aux repas
export const WITH_FOOD_OPTIONS = ['with', 'without', 'any'] as const;
export type WithFoodOption = typeof WITH_FOOD_OPTIONS[number];

// D'ou vient la confirmation d'une prise
export const INTAKE_SOURCES = ['caregiver', 'kiosk', 'phone', 'link'] as const;
export type IntakeSource = typeof INTAKE_SOURCES[number];

// Categories d'evenements du calendrier
export const EVENT_CATEGORIES = ['visit', 'medical', 'nurse', 'aide', 'other'] as const;
export type EventCategory = typeof EVENT_CATEGORIES[number];

// Categories de documents
export const DOCUMENT_CATEGORIES = ['prescription', 'report', 'insurance', 'legal', 'other'] as const;
export type DocumentCategory = typeof DOCUMENT_CATEGORIES[number];

// Categories de contacts du carnet d'adresses
export const CONTACT_CATEGORIES = ['doctor', 'nurse', 'aide', 'physio', 'pharmacy', 'family', 'neighbor', 'other'] as const;
export type ContactCategory = typeof CONTACT_CATEGORIES[number];

// Categories de frais partages
export const EXPENSE_CATEGORIES = ['pharmacy', 'aide', 'equipment', 'works', 'food', 'transport', 'other'] as const;
export type ExpenseCategory = typeof EXPENSE_CATEGORIES[number];

// Types d'aides francaises
export const AID_TYPES = ['apa', 'cesu', 'tax_credit', 'other'] as const;
export type AidType = typeof AID_TYPES[number];

// Categories de taches
export const TASK_CATEGORIES = ['shopping', 'pharmacy', 'laundry', 'admin', 'transport', 'other'] as const;
export type TaskCategory = typeof TASK_CATEGORIES[number];

// Categories de la liste de courses
export const SHOPPING_CATEGORIES = {
    FOOD: 'Alimentation',
    HOUSEHOLD: 'Ménage',
    HEALTH: 'Santé',
    HYGIENE: 'Hygiène',
    OTHER: 'Autre',
} as const;
export type ShoppingCategory = typeof SHOPPING_CATEGORIES[keyof typeof SHOPPING_CATEGORIES];

// Frequences de taches
export const TASK_FREQUENCIES = {
    DAILY: 'Quotidien',
    WEEKLY: 'Hebdomadaire',
    MONTHLY: 'Mensuel',
    YEARLY: 'Annuel',
    ONCE: 'Une fois',
} as const;
export type TaskFrequency = typeof TASK_FREQUENCIES[keyof typeof TASK_FREQUENCIES];

// Jours de la semaine
export const DAYS_OF_WEEK = {
    MONDAY: 'Lundi',
    TUESDAY: 'Mardi',
    WEDNESDAY: 'Mercredi',
    THURSDAY: 'Jeudi',
    FRIDAY: 'Vendredi',
    SATURDAY: 'Samedi',
    SUNDAY: 'Dimanche',
} as const;
export type DayOfWeek = typeof DAYS_OF_WEEK[keyof typeof DAYS_OF_WEEK];

// Priorite des taches
export const TASK_PRIORITY = {
    LOW: 'Basse',
    MEDIUM: 'Moyenne',
    HIGH: 'Haute',
} as const;
export type TaskPriority = typeof TASK_PRIORITY[keyof typeof TASK_PRIORITY];

// Groupes sanguins
export const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export type BloodType = typeof BLOOD_TYPES[number];

// Niveaux d'alerte canicule (calques sur la vigilance: orange, rouge)
export const HEATWAVE_LEVELS = ['orange', 'red'] as const;
export type HeatwaveLevel = typeof HEATWAVE_LEVELS[number];
