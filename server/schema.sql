-- OpenCare Database Schema
-- Tout le domaine est rattache a un cercle de soin (care_circles).
-- Un cercle correspond a un proche aide; un utilisateur peut appartenir
-- a plusieurs cercles avec un role distinct dans chacun.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Comptes utilisateurs (aidants)
-- ============================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    language VARCHAR(8) NOT NULL DEFAULT 'fr',
    avatar_url TEXT,
    calendar_token VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_users_calendar_token ON users(calendar_token);

-- ============================================================
-- Cercles de soin
-- ============================================================
CREATE TABLE care_circles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
    settings JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Roles: admin, family, professional, neighbor, viewer
CREATE TABLE circle_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'family'
        CHECK (role IN ('admin', 'family', 'professional', 'neighbor', 'viewer')),
    color VARCHAR(7) NOT NULL DEFAULT '#5B7C99',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(circle_id, user_id)
);
CREATE INDEX idx_circle_members_circle ON circle_members(circle_id);
CREATE INDEX idx_circle_members_user ON circle_members(user_id);

-- Le proche aide (1 par cercle)
CREATE TABLE care_recipients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID UNIQUE NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    birth_date DATE,
    photo_url TEXT,
    address TEXT,
    phone VARCHAR(30),
    blood_type VARCHAR(3),
    allergies TEXT,
    medical_history TEXT,
    mobility_notes TEXT,
    diet_notes TEXT,
    social_security_number VARCHAR(30),
    insurance_info TEXT,
    advance_directives TEXT,
    gp_name VARCHAR(255),
    gp_phone VARCHAR(30),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Page "Qui je suis": recit de vie montre aux nouveaux intervenants
CREATE TABLE recipient_stories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID UNIQUE NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    sections JSONB NOT NULL DEFAULT '[]',
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Invitations a rejoindre un cercle (avec compte)
CREATE TABLE circle_invites (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    token VARCHAR(64) UNIQUE NOT NULL,
    invitee_email TEXT,
    role VARCHAR(20) NOT NULL DEFAULT 'family'
        CHECK (role IN ('admin', 'family', 'professional', 'neighbor', 'viewer')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_circle_invites_token ON circle_invites(token);
CREATE INDEX idx_circle_invites_circle ON circle_invites(circle_id);

-- Liens magiques: intervenants sans compte (auxiliaire, infirmiere)
-- Portee limitee: ecrire au journal, voir le jour meme
CREATE TABLE caregiver_links (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    token VARCHAR(64) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    role_label VARCHAR(100),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMP,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_caregiver_links_token ON caregiver_links(token);
CREATE INDEX idx_caregiver_links_circle ON caregiver_links(circle_id);

-- ============================================================
-- Journal de liaison (coeur de l'app)
-- ============================================================
-- Types: visit, note, vital, medication, incident, mood
CREATE TABLE journal_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    caregiver_link_id UUID REFERENCES caregiver_links(id) ON DELETE SET NULL,
    author_name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'note'
        CHECK (type IN ('visit', 'note', 'vital', 'medication', 'incident', 'mood')),
    content TEXT NOT NULL DEFAULT '',
    data JSONB NOT NULL DEFAULT '{}',
    occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_journal_entries_circle_occurred ON journal_entries(circle_id, occurred_at DESC);
CREATE INDEX idx_journal_entries_type ON journal_entries(circle_id, type);

CREATE TABLE journal_photos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_journal_photos_entry ON journal_photos(entry_id);

-- ============================================================
-- Sante: constantes et medicaments
-- ============================================================
-- Types: weight, bp (value=systolique, value2=diastolique), pain, mood, temperature, glucose
CREATE TABLE vitals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL
        CHECK (type IN ('weight', 'bp', 'pain', 'mood', 'temperature', 'glucose')),
    value NUMERIC(8, 2) NOT NULL,
    value2 NUMERIC(8, 2),
    unit VARCHAR(20),
    measured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
    recorded_by_user UUID REFERENCES users(id) ON DELETE SET NULL,
    recorded_by_link UUID REFERENCES caregiver_links(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_vitals_circle_type_date ON vitals(circle_id, type, measured_at DESC);

CREATE TABLE medications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    dosage VARCHAR(100),
    form VARCHAR(50),
    instructions TEXT,
    photo_url TEXT,
    prescriber VARCHAR(255),
    start_date DATE,
    end_date DATE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_medications_circle ON medications(circle_id, active);

-- Horaires de prise: time_of_day + jours de semaine (1=lundi ... 7=dimanche)
CREATE TABLE medication_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    medication_id UUID NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
    time_of_day TIME NOT NULL,
    days_of_week JSONB NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
    label VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_medication_schedules_med ON medication_schedules(medication_id);

-- Occurrences de prise generees; statut confirme depuis le journal ou le kiosk
CREATE TABLE medication_intakes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    medication_id UUID NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
    schedule_id UUID REFERENCES medication_schedules(id) ON DELETE SET NULL,
    due_at TIMESTAMP NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'taken', 'skipped', 'missed')),
    confirmed_by_user UUID REFERENCES users(id) ON DELETE SET NULL,
    confirmed_by_link UUID REFERENCES caregiver_links(id) ON DELETE SET NULL,
    confirmed_at TIMESTAMP,
    journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(medication_id, schedule_id, due_at)
);
CREATE INDEX idx_medication_intakes_circle_due ON medication_intakes(circle_id, due_at DESC);
CREATE INDEX idx_medication_intakes_status ON medication_intakes(circle_id, status);

-- Ordonnances et renouvellements
CREATE TABLE prescriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    prescribed_by VARCHAR(255),
    issued_date DATE,
    renewal_date DATE,
    reminder_days INTEGER NOT NULL DEFAULT 7,
    document_id UUID,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_prescriptions_circle ON prescriptions(circle_id);

-- ============================================================
-- Organisation: calendrier, taches, courses
-- ============================================================
-- Categories: visit, medical, nurse, aide, other
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(20) NOT NULL DEFAULT 'other'
        CHECK (category IN ('visit', 'medical', 'nurse', 'aide', 'other')),
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    location TEXT,
    rrule TEXT,
    member_ids JSONB DEFAULT '[]'::jsonb,
    reminder_30min BOOLEAN DEFAULT FALSE,
    reminder_1hour BOOLEAN DEFAULT FALSE,
    notes TEXT,
    caldav_uid TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_events_circle_start ON events(circle_id, start_time);
CREATE UNIQUE INDEX idx_events_caldav_uid ON events(circle_id, caldav_uid) WHERE caldav_uid IS NOT NULL;

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(30) NOT NULL DEFAULT 'other',
    is_completed BOOLEAN DEFAULT FALSE,
    due_date TIMESTAMP,
    frequency VARCHAR(50),
    priority VARCHAR(50),
    assigned_to JSONB DEFAULT '[]'::jsonb,
    completed_at TIMESTAMP,
    completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_tasks_circle ON tasks(circle_id);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
CREATE INDEX idx_tasks_assigned_to ON tasks USING GIN (assigned_to);

CREATE TABLE shopping_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL,
    quantity DECIMAL(10, 2),
    unit VARCHAR(50),
    is_checked BOOLEAN DEFAULT FALSE,
    notes TEXT,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_shopping_items_circle ON shopping_items(circle_id);

-- Post-its du cercle
CREATE TABLE circle_notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    author_name VARCHAR(100) NOT NULL,
    content VARCHAR(500) NOT NULL,
    color VARCHAR(20) NOT NULL DEFAULT 'yellow',
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_circle_notes_circle ON circle_notes(circle_id);

-- ============================================================
-- Messagerie du cercle
-- ============================================================
-- channel: 'circle' (fil commun) ou 'dm' (direct entre deux membres)
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    channel VARCHAR(10) NOT NULL DEFAULT 'circle' CHECK (channel IN ('circle', 'dm')),
    author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    attachments JSONB NOT NULL DEFAULT '[]',
    edited_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_messages_circle_created ON messages(circle_id, created_at DESC);
CREATE INDEX idx_messages_dm ON messages(circle_id, channel, recipient_user_id);

-- ============================================================
-- Documents et contacts
-- ============================================================
-- Categories: prescription, report, insurance, legal, other
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(30) NOT NULL DEFAULT 'other'
        CHECK (category IN ('prescription', 'report', 'insurance', 'legal', 'other')),
    file_path TEXT NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_documents_circle ON documents(circle_id, category);

CREATE TABLE contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(30) NOT NULL DEFAULT 'other',
    organization VARCHAR(255),
    phone VARCHAR(30),
    phone2 VARCHAR(30),
    email VARCHAR(255),
    address TEXT,
    has_key BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_contacts_circle ON contacts(circle_id);

-- ============================================================
-- Frais partages (facon Tricount) et aides
-- ============================================================
-- split_mode: equal (entre membres family/admin) ou custom (parts dans splits)
CREATE TABLE expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    paid_by UUID NOT NULL REFERENCES circle_members(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    category VARCHAR(30) NOT NULL DEFAULT 'other',
    description TEXT,
    date DATE NOT NULL,
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    split_mode VARCHAR(10) NOT NULL DEFAULT 'equal' CHECK (split_mode IN ('equal', 'custom')),
    splits JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_expenses_circle_date ON expenses(circle_id, date DESC);

CREATE TABLE expense_settlements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    from_member UUID NOT NULL REFERENCES circle_members(id) ON DELETE CASCADE,
    to_member UUID NOT NULL REFERENCES circle_members(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    date DATE NOT NULL,
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_expense_settlements_circle ON expense_settlements(circle_id);

-- Aides francaises: apa, cesu, tax_credit, other
CREATE TABLE aid_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL DEFAULT 'other'
        CHECK (type IN ('apa', 'cesu', 'tax_credit', 'other')),
    label VARCHAR(255),
    amount DECIMAL(10, 2) NOT NULL,
    period_start DATE,
    period_end DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_aid_records_circle ON aid_records(circle_id);

-- ============================================================
-- Fiche urgence (QR frigo), veille passive, syntheses, relais, kiosk
-- ============================================================
CREATE TABLE emergency_sheets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID UNIQUE NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    public_token VARCHAR(64) UNIQUE NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    extra_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Signaux de presence (webhooks Home Assistant)
CREATE TABLE presence_signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    source VARCHAR(100) NOT NULL,
    kind VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_presence_signals_circle_time ON presence_signals(circle_id, occurred_at DESC);

-- Regle d'alerte: aucun signe de vie avant no_activity_before -> alerte cascade
CREATE TABLE presence_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID UNIQUE NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    no_activity_before TIME NOT NULL DEFAULT '11:00',
    alert_member_ids JSONB NOT NULL DEFAULT '[]',
    last_alert_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Synthese hebdo generee par l'IA chaque dimanche
CREATE TABLE weekly_digests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    week_start DATE NOT NULL,
    content JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(circle_id, week_start)
);

-- Mode relais vacances: pack de passation
CREATE TABLE handover_packs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    token VARCHAR(64) UNIQUE NOT NULL,
    starts_on DATE NOT NULL,
    ends_on DATE NOT NULL,
    content JSONB NOT NULL DEFAULT '{}',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_handover_packs_circle ON handover_packs(circle_id);

-- Tablettes kiosk chez le proche
CREATE TABLE kiosk_devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    token VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL DEFAULT 'Tablette',
    settings JSONB NOT NULL DEFAULT '{}',
    last_seen_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_kiosk_devices_circle ON kiosk_devices(circle_id);

-- ============================================================
-- Infra par cercle: IA, integrations
-- ============================================================
CREATE TABLE ai_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID UNIQUE NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('ollama', 'openai', 'anthropic')),
    base_url TEXT,
    encrypted_api_key TEXT,
    model VARCHAR(100) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE integrations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    display_name VARCHAR(100),
    base_url TEXT NOT NULL,
    encrypted_credentials TEXT,
    config JSONB DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'connected',
    last_synced_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(circle_id, type)
);
CREATE INDEX idx_integrations_circle ON integrations(circle_id);

-- ============================================================
-- Infra par utilisateur: notifications, push
-- ============================================================
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    circle_id UUID REFERENCES care_circles(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    related_id UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);

CREATE TABLE push_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    keys JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, endpoint)
);

-- ============================================================
-- Trigger updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_care_circles_updated_at BEFORE UPDATE ON care_circles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_care_recipients_updated_at BEFORE UPDATE ON care_recipients FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_recipient_stories_updated_at BEFORE UPDATE ON recipient_stories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_journal_entries_updated_at BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_medications_updated_at BEFORE UPDATE ON medications FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_prescriptions_updated_at BEFORE UPDATE ON prescriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_events_updated_at BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_shopping_items_updated_at BEFORE UPDATE ON shopping_items FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_expenses_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_aid_records_updated_at BEFORE UPDATE ON aid_records FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_emergency_sheets_updated_at BEFORE UPDATE ON emergency_sheets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_presence_rules_updated_at BEFORE UPDATE ON presence_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_ai_settings_updated_at BEFORE UPDATE ON ai_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_integrations_updated_at BEFORE UPDATE ON integrations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_notifications_updated_at BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
