import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookUser, Building2, Edit2, KeyRound, Mail, MapPin, Phone, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Badge, Button, Card, CardContent, Dialog, Input, Select, Textarea } from '../components/ui';
import { EmptyState } from '../components/app';

const CONTACT_CATEGORIES = ['doctor', 'nurse', 'aide', 'physio', 'pharmacy', 'family', 'neighbor', 'other'] as const;

interface Contact {
    id: string;
    name: string;
    category: string;
    organization: string | null;
    phone: string | null;
    phone2: string | null;
    email: string | null;
    address: string | null;
    has_key: boolean;
    notes: string | null;
}

const emptyForm = {
    name: '',
    category: 'doctor',
    organization: '',
    phone: '',
    phone2: '',
    email: '',
    address: '',
    has_key: false,
    notes: '',
};

const telHref = (phone: string): string => `tel:${phone.replace(/[\s.()-]/g, '')}`;

const Contacts: React.FC = () => {
    const { t, i18n } = useTranslation(['contacts', 'common']);
    const { activeCircle, canWriteContent } = useCircle();

    const [contacts, setContacts] = useState<Contact[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState<string>('all');

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingContact, setEditingContact] = useState<Contact | null>(null);
    const [form, setForm] = useState(emptyForm);
    const [formError, setFormError] = useState('');

    const categoryLabel = (category: string): string =>
        t(`contacts:categories.${category}`, { defaultValue: category });

    const loadContacts = async () => {
        if (!activeCircle) {
            setLoading(false);
            return;
        }
        try {
            const response = await api.get<{ success: boolean; data: Contact[] }>('/api/contacts');
            if (response.success) setContacts(response.data);
            setError('');
        } catch (err) {
            console.error('Failed to load contacts:', err);
            setError(err instanceof Error ? err.message : t('contacts:errors.load'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        void loadContacts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    useWebSocketUpdates('contacts', () => {
        void loadContacts();
    });

    const openCreate = () => {
        setEditingContact(null);
        setForm(emptyForm);
        setFormError('');
        setDialogOpen(true);
    };

    const openEdit = (contact: Contact) => {
        setEditingContact(contact);
        setForm({
            name: contact.name,
            category: contact.category,
            organization: contact.organization ?? '',
            phone: contact.phone ?? '',
            phone2: contact.phone2 ?? '',
            email: contact.email ?? '',
            address: contact.address ?? '',
            has_key: contact.has_key,
            notes: contact.notes ?? '',
        });
        setFormError('');
        setDialogOpen(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError('');
        const payload = {
            name: form.name.trim(),
            category: form.category,
            organization: form.organization.trim() || null,
            phone: form.phone.trim() || null,
            phone2: form.phone2.trim() || null,
            email: form.email.trim() || null,
            address: form.address.trim() || null,
            has_key: form.has_key,
            notes: form.notes.trim() || null,
        };
        try {
            if (editingContact) {
                await api.put(`/api/contacts/${editingContact.id}`, payload);
            } else {
                await api.post('/api/contacts', payload);
            }
            setDialogOpen(false);
            void loadContacts();
        } catch (err) {
            console.error('Failed to save contact:', err);
            setFormError(err instanceof Error ? err.message : t('contacts:errors.save'));
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm(t('contacts:confirm.delete'))) return;
        try {
            await api.delete(`/api/contacts/${id}`);
            void loadContacts();
        } catch (err) {
            console.error('Failed to delete contact:', err);
            setError(err instanceof Error ? err.message : t('contacts:errors.delete'));
        }
    };

    if (loading || !activeCircle) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="animate-pulse font-medium text-muted-foreground">{t('contacts:loading')}</p>
                </div>
            </div>
        );
    }

    const sorted = [...contacts].sort((a, b) => a.name.localeCompare(b.name, i18n.language));
    const filtered = filter === 'all' ? sorted : sorted.filter((c) => c.category === filter);
    // When no filter is active, group the list by category for easier scanning.
    const groups: Array<{ category: string; items: Contact[] }> =
        filter === 'all'
            ? CONTACT_CATEGORIES.map((category) => ({
                  category,
                  items: sorted.filter((c) => c.category === category),
              })).filter((group) => group.items.length > 0)
            : [{ category: filter, items: filtered }];

    const renderContact = (contact: Contact) => (
        <Card key={contact.id} hover={false}>
            <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-body font-semibold">{contact.name}</span>
                            <Badge variant="primary">{categoryLabel(contact.category)}</Badge>
                            {contact.has_key ? (
                                <Badge variant="secondary" className="gap-1">
                                    <KeyRound className="h-3 w-3" />
                                    {t('contacts:hasKey')}
                                </Badge>
                            ) : null}
                        </div>
                        {contact.organization ? (
                            <p className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
                                <Building2 className="h-3.5 w-3.5 shrink-0" />
                                {contact.organization}
                            </p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                            {[contact.phone, contact.phone2].filter((p): p is string => Boolean(p)).map((phone) => (
                                <a
                                    key={phone}
                                    href={telHref(phone)}
                                    className="inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-primary hover:underline"
                                >
                                    <Phone className="h-3.5 w-3.5 shrink-0" />
                                    {phone}
                                </a>
                            ))}
                            {contact.email ? (
                                <a
                                    href={`mailto:${contact.email}`}
                                    className="inline-flex min-h-[44px] items-center gap-1.5 break-all text-caption font-medium text-primary hover:underline"
                                >
                                    <Mail className="h-3.5 w-3.5 shrink-0" />
                                    {contact.email}
                                </a>
                            ) : null}
                        </div>
                        {contact.address ? (
                            <p className="mt-1 flex items-start gap-1.5 text-caption text-muted-foreground">
                                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                {contact.address}
                            </p>
                        ) : null}
                        {contact.notes ? (
                            <p className="mt-1.5 text-caption text-muted-foreground">{contact.notes}</p>
                        ) : null}
                    </div>
                    {canWriteContent ? (
                        <div className="flex shrink-0 items-center gap-1">
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('common:actions.edit')}
                                onClick={() => openEdit(contact)}
                            >
                                <Edit2 className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t('common:actions.delete')}
                                onClick={() => void handleDelete(contact.id)}
                            >
                                <Trash2 className="h-4 w-4 text-danger" />
                            </Button>
                        </div>
                    ) : null}
                </div>
            </CardContent>
        </Card>
    );

    return (
        <div className="mx-auto max-w-4xl space-y-6">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
                <div>
                    <h1 className="mb-1 text-h1">{t('contacts:title')}</h1>
                    <p className="text-body text-muted-foreground">{t('contacts:subtitle')}</p>
                </div>
                {canWriteContent ? (
                    <Button onClick={openCreate}>
                        <Plus className="mr-2 h-4 w-4" />
                        {t('contacts:newContact')}
                    </Button>
                ) : null}
            </div>

            {/* Category filter pills */}
            <div className="flex flex-wrap gap-2">
                {(['all', ...CONTACT_CATEGORIES] as string[]).map((category) => (
                    <button
                        key={category}
                        type="button"
                        onClick={() => setFilter(category)}
                        className={`min-h-[44px] rounded-pill border px-4 text-caption font-medium transition-colors ${
                            filter === category
                                ? 'border-primary bg-primary-soft text-primary'
                                : 'border-border bg-surface text-muted-foreground hover:border-border-strong'
                        }`}
                    >
                        {category === 'all' ? t('contacts:filters.all') : categoryLabel(category)}
                    </button>
                ))}
            </div>

            {filtered.length === 0 ? (
                <EmptyState
                    icon={<BookUser className="h-10 w-10" />}
                    title={contacts.length === 0 ? t('contacts:empty.none') : t('contacts:empty.noMatch')}
                    actionLabel={canWriteContent && contacts.length === 0 ? t('contacts:empty.action') : undefined}
                    onAction={canWriteContent && contacts.length === 0 ? openCreate : undefined}
                />
            ) : (
                <div className="space-y-6">
                    {groups.map((group) => (
                        <section key={group.category} className="space-y-3">
                            <h2 className="text-label font-medium uppercase tracking-wide text-muted-foreground">
                                {categoryLabel(group.category)}
                            </h2>
                            {group.items.map(renderContact)}
                        </section>
                    ))}
                </div>
            )}

            {/* Create / edit dialog */}
            <Dialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title={editingContact ? t('contacts:dialog.editTitle') : t('contacts:dialog.createTitle')}
            >
                <form onSubmit={handleSubmit} className="space-y-4">
                    {formError ? (
                        <div className="rounded-input border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">
                            {formError}
                        </div>
                    ) : null}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input
                            label={t('contacts:form.name')}
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            required
                            placeholder={t('contacts:form.namePlaceholder')}
                        />
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('contacts:form.category')}
                            </label>
                            <Select
                                value={form.category}
                                onValueChange={(value) => setForm({ ...form, category: value })}
                                options={CONTACT_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
                            />
                        </div>
                    </div>
                    <Input
                        label={t('contacts:form.organization')}
                        value={form.organization}
                        onChange={(e) => setForm({ ...form, organization: e.target.value })}
                        placeholder={t('contacts:form.organizationPlaceholder')}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input
                            label={t('contacts:form.phone')}
                            type="tel"
                            value={form.phone}
                            onChange={(e) => setForm({ ...form, phone: e.target.value })}
                        />
                        <Input
                            label={t('contacts:form.phone2')}
                            type="tel"
                            value={form.phone2}
                            onChange={(e) => setForm({ ...form, phone2: e.target.value })}
                        />
                    </div>
                    <Input
                        label={t('contacts:form.email')}
                        type="email"
                        value={form.email}
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                    />
                    <Input
                        label={t('contacts:form.address')}
                        value={form.address}
                        onChange={(e) => setForm({ ...form, address: e.target.value })}
                    />
                    <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-input border border-border bg-surface-2/40 px-3">
                        <input
                            type="checkbox"
                            checked={form.has_key}
                            onChange={(e) => setForm({ ...form, has_key: e.target.checked })}
                            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                        />
                        <span className="text-caption">{t('contacts:form.hasKey')}</span>
                    </label>
                    <Textarea
                        label={t('contacts:form.notes')}
                        rows={2}
                        value={form.notes}
                        onChange={(e) => setForm({ ...form, notes: e.target.value })}
                        placeholder={t('contacts:form.notesPlaceholder')}
                    />
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit">
                            {editingContact ? t('common:actions.save') : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Contacts;
