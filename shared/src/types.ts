import type {
    ShoppingCategory,
    TaskFrequency,
    TaskPriority,
    TaskCategory,
    BloodType,
    CircleRole,
    JournalEntryType,
    VitalType,
    IntakeStatus,
    EventCategory,
    DocumentCategory,
    ContactCategory,
    ExpenseCategory,
    AidType,
    HeatwaveLevel,
} from './constants';

// Base Entity
export interface BaseEntity {
    id: string;
    created_at: Date;
    updated_at: Date;
}

// Compte utilisateur (aidant)
export interface User extends BaseEntity {
    email: string;
    password_hash: string;
    name: string;
    language: string;
    avatar_url?: string;
}

// Cercle de soin (un cercle = un proche aide)
export interface CareCircle extends BaseEntity {
    name: string;
    created_by?: string;
    currency: string;
    /** Foyer (couple): cercles partageant ce meme id; NULL = cercle isole. */
    household_id?: string | null;
    settings: Record<string, unknown>;
}

export interface CircleMember {
    id: string;
    circle_id: string;
    user_id: string;
    role: CircleRole;
    color: string;
    created_at: Date;
    // Champs joints depuis users pour l'affichage
    name?: string;
    email?: string;
    avatar_url?: string;
}

// Le proche aide
export interface CareRecipient extends BaseEntity {
    circle_id: string;
    first_name: string;
    last_name?: string;
    birth_date?: string;
    photo_url?: string;
    address?: string;
    phone?: string;
    blood_type?: BloodType;
    allergies?: string;
    medical_history?: string;
    mobility_notes?: string;
    diet_notes?: string;
    social_security_number?: string;
    insurance_info?: string;
    advance_directives?: string;
    gp_name?: string;
    gp_phone?: string;
    notes?: string;
}

// Suivi canicule / fortes chaleurs (un par cercle)
export interface HeatwaveSettings {
    circle_id: string;
    /** Fonction activee pour le cercle. */
    enabled: boolean;
    /** Episode de forte chaleur en cours (bascule manuelle par un aidant). */
    active: boolean;
    level: HeatwaveLevel;
    /** Creneaux HH:MM des rappels d'hydratation pousses aux aidants. */
    reminder_times: string[];
    /** Horodatage naif 'YYYY-MM-DDTHH:mm:ss' du dernier declenchement, ou null. */
    activated_at: string | null;
}

export interface CircleInvite {
    id: string;
    circle_id: string;
    created_by?: string;
    token: string;
    invitee_email?: string;
    role: CircleRole;
    status: 'pending' | 'accepted' | 'revoked';
    expires_at: Date;
    created_at: Date;
}

// Lien magique pour intervenant sans compte
export interface CaregiverLink {
    id: string;
    circle_id: string;
    token: string;
    display_name: string;
    role_label?: string;
    created_by?: string;
    revoked: boolean;
    expires_at?: Date;
    last_used_at?: Date;
    created_at: Date;
}

// Journal de liaison
export interface JournalEntry extends BaseEntity {
    circle_id: string;
    author_user_id?: string;
    caregiver_link_id?: string;
    author_name: string;
    type: JournalEntryType;
    content: string;
    data: Record<string, unknown>;
    occurred_at: Date;
    photos?: JournalPhoto[];
}

export interface JournalPhoto {
    id: string;
    entry_id: string;
    file_path: string;
    mime_type?: string;
    size_bytes?: number;
    created_at: Date;
}

// Constante de sante (bp: value=systolique, value2=diastolique)
export interface Vital {
    id: string;
    circle_id: string;
    type: VitalType;
    value: number;
    value2?: number;
    unit?: string;
    measured_at: Date;
    journal_entry_id?: string;
    recorded_by_user?: string;
    recorded_by_link?: string;
    notes?: string;
    created_at: Date;
}

// Medicaments
export interface Medication extends BaseEntity {
    circle_id: string;
    name: string;
    dosage?: string;
    form?: string;
    instructions?: string;
    photo_url?: string;
    prescriber?: string;
    start_date?: string;
    end_date?: string;
    active: boolean;
    schedules?: MedicationSchedule[];
}

export interface MedicationSchedule {
    id: string;
    medication_id: string;
    time_of_day: string;
    days_of_week: number[];
    label?: string;
    created_at: Date;
}

export interface MedicationIntake {
    id: string;
    circle_id: string;
    medication_id: string;
    schedule_id?: string;
    due_at: Date;
    status: IntakeStatus;
    confirmed_by_user?: string;
    confirmed_by_link?: string;
    confirmed_at?: Date;
    journal_entry_id?: string;
    created_at: Date;
    // Joint pour l'affichage
    medication_name?: string;
    dosage?: string;
}

export interface Prescription extends BaseEntity {
    circle_id: string;
    title: string;
    prescribed_by?: string;
    issued_date?: string;
    renewal_date?: string;
    reminder_days: number;
    document_id?: string;
    notes?: string;
}

// Evenement du calendrier
export interface CircleEvent extends BaseEntity {
    circle_id: string;
    title: string;
    description?: string;
    category: EventCategory;
    start_time: Date;
    end_time?: Date;
    location?: string;
    rrule?: string;
    member_ids?: string[];
    reminder_30min: boolean;
    reminder_1hour: boolean;
    notes?: string;
    caldav_uid?: string;
    created_by?: string;
    members_data?: Array<{ id: string; name: string; color: string }>;
}

// Tache
export interface Task extends BaseEntity {
    circle_id: string;
    title: string;
    description?: string;
    category: TaskCategory;
    is_completed: boolean;
    due_date?: Date;
    frequency?: TaskFrequency;
    priority?: TaskPriority;
    assigned_to?: string[];
    assigned_to_members?: Array<{ id: string; name: string; color: string }>;
    completed_at?: Date;
    completed_by?: string;
}

// Article de courses
export interface ShoppingItem extends BaseEntity {
    circle_id: string;
    name: string;
    category: ShoppingCategory;
    quantity?: number;
    unit?: string;
    is_checked: boolean;
    notes?: string;
    added_by?: string;
}

// Post-it du cercle
export interface CircleNote {
    id: string;
    circle_id: string;
    author_name: string;
    content: string;
    color: string;
    expires_at?: Date;
    created_at: Date;
}

// Message (fil du cercle ou direct)
export interface Message {
    id: string;
    circle_id: string;
    channel: 'circle' | 'dm';
    author_user_id: string;
    recipient_user_id?: string;
    content: string;
    attachments: Array<{ name: string; path: string; mime?: string }>;
    edited_at?: Date;
    created_at: Date;
    author_name?: string;
    author_avatar?: string;
}

// Document
export interface CircleDocument {
    id: string;
    circle_id: string;
    title: string;
    category: DocumentCategory;
    file_path: string;
    mime_type?: string;
    size_bytes?: number;
    uploaded_by?: string;
    notes?: string;
    created_at: Date;
}

// Contact du carnet d'adresses
export interface Contact extends BaseEntity {
    circle_id: string;
    name: string;
    category: ContactCategory;
    organization?: string;
    phone?: string;
    phone2?: string;
    email?: string;
    address?: string;
    has_key: boolean;
    notes?: string;
}

// Frais partage
export interface Expense extends BaseEntity {
    circle_id: string;
    paid_by: string;
    amount: number;
    category: ExpenseCategory;
    description?: string;
    date: string;
    document_id?: string;
    split_mode: 'equal' | 'custom';
    splits: Array<{ member_id: string; share: number }>;
    paid_by_name?: string;
}

export interface ExpenseSettlement {
    id: string;
    circle_id: string;
    from_member: string;
    to_member: string;
    amount: number;
    date: string;
    note?: string;
    created_at: Date;
}

export interface AidRecord extends BaseEntity {
    circle_id: string;
    type: AidType;
    label?: string;
    amount: number;
    period_start?: string;
    period_end?: string;
    notes?: string;
}

// Notification
export interface Notification extends BaseEntity {
    user_id: string;
    circle_id?: string;
    title: string;
    message: string;
    type: string;
    is_read: boolean;
    related_id?: string;
}

// API Response Types
export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}

export interface PaginatedResponse<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}
