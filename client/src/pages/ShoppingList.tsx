import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Check, Trash2, Pencil, ShoppingBasket } from 'lucide-react';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Button, Dialog, Input, Select, Textarea } from '../components/ui';
import { EmptyState } from '../components/app';
import { cn } from '../lib/utils';

// Catégories proposées (le serveur accepte des chaînes libres, défaut "other")
const ITEM_CATEGORIES = ['food', 'hygiene', 'household', 'pharmacy', 'other'] as const;

interface ShoppingItem {
    id: string;
    name: string;
    category: string;
    quantity?: number | string | null;
    unit?: string | null;
    is_checked: boolean;
    notes?: string | null;
    created_at: string;
}

const ShoppingList: React.FC = () => {
    const { t } = useTranslation(['shopping', 'common']);
    const { activeCircle, canWriteJournal } = useCircle();

    const [items, setItems] = useState<ShoppingItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [newName, setNewName] = useState('');
    const [newCategory, setNewCategory] = useState('');
    const [adding, setAdding] = useState(false);

    const [editingItem, setEditingItem] = useState<ShoppingItem | null>(null);
    const [editForm, setEditForm] = useState({ quantity: '', unit: '', notes: '' });
    const [savingEdit, setSavingEdit] = useState(false);

    const categoryLabel = (value: string) => t(`shopping:categories.${value}`, { defaultValue: value });

    const loadItems = async () => {
        try {
            const response = await api.get<{ success: boolean; data: ShoppingItem[] }>('/api/shopping');
            if (response.success) {
                setItems(response.data);
                setError('');
            }
        } catch (err) {
            console.error('Failed to load shopping items:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.load'));
        }
    };

    // Recharge quand le cercle actif change
    useEffect(() => {
        if (!activeCircle?.id) return;
        setLoading(true);
        void loadItems().finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    useWebSocketUpdates('shopping', () => {
        void loadItems();
    });

    const addItem = async (e: React.FormEvent) => {
        e.preventDefault();
        const name = newName.trim();
        if (!name || adding) return;
        setError('');
        setAdding(true);
        try {
            const response = await api.post<{ success: boolean; data: ShoppingItem }>('/api/shopping', {
                name,
                category: newCategory || 'other',
            });
            // data null = écriture en file hors ligne: insertion locale optimiste.
            if (response.success && response.data) {
                setItems((prev) => [response.data, ...prev]);
                setNewName('');
            } else if (response.success) {
                const optimistic: ShoppingItem = {
                    id: `offline-${Date.now()}`,
                    name,
                    category: newCategory || 'other',
                    is_checked: false,
                } as ShoppingItem;
                setItems((prev) => [optimistic, ...prev]);
                setNewName('');
            }
        } catch (err) {
            console.error('Failed to add item:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.add'));
        } finally {
            setAdding(false);
        }
    };

    const toggleItem = async (item: ShoppingItem) => {
        if (!canWriteJournal) return;
        setError('');
        try {
            const response = await api.put<{ success: boolean; data: ShoppingItem }>(`/api/shopping/${item.id}`, {
                is_checked: !item.is_checked,
            });
            if (response.success && response.data) {
                setItems((prev) => prev.map((current) => (current.id === item.id ? response.data : current)));
            } else if (response.success) {
                setItems((prev) => prev.map((current) => (
                    current.id === item.id ? { ...current, is_checked: !item.is_checked } : current
                )));
            }
        } catch (err) {
            console.error('Failed to toggle item:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.toggle'));
        }
    };

    const deleteItem = async (id: string) => {
        setError('');
        try {
            await api.delete(`/api/shopping/${id}`);
            setItems((prev) => prev.filter((item) => item.id !== id));
        } catch (err) {
            console.error('Failed to delete item:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.delete'));
        }
    };

    const clearChecked = async () => {
        setError('');
        try {
            await api.delete('/api/shopping/checked/clear');
            setItems((prev) => prev.filter((item) => !item.is_checked));
        } catch (err) {
            console.error('Failed to clear checked items:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.clear'));
        }
    };

    const openEdit = (item: ShoppingItem) => {
        setEditingItem(item);
        setEditForm({
            quantity: item.quantity !== null && item.quantity !== undefined ? String(item.quantity) : '',
            unit: item.unit || '',
            notes: item.notes || '',
        });
    };

    const saveEdit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingItem) return;

        const quantityRaw = editForm.quantity.trim().replace(',', '.');
        const quantity = quantityRaw === '' ? null : Number(quantityRaw);
        if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0)) {
            setError(t('shopping:errors.quantityInvalid'));
            return;
        }

        setError('');
        setSavingEdit(true);
        try {
            const response = await api.put<{ success: boolean; data: ShoppingItem }>(
                `/api/shopping/${editingItem.id}`,
                {
                    quantity,
                    unit: editForm.unit,
                    notes: editForm.notes,
                }
            );
            if (response.success && response.data) {
                setItems((prev) =>
                    prev.map((current) => (current.id === editingItem.id ? response.data : current))
                );
                setEditingItem(null);
            } else if (response.success) {
                setItems((prev) =>
                    prev.map((current) => (
                        current.id === editingItem.id
                            ? { ...current, quantity: quantity ?? undefined, unit: editForm.unit, notes: editForm.notes }
                            : current
                    ))
                );
                setEditingItem(null);
            }
        } catch (err) {
            console.error('Failed to update item:', err);
            setError(err instanceof Error ? err.message : t('shopping:errors.update'));
        } finally {
            setSavingEdit(false);
        }
    };

    const pendingItems = useMemo(() => items.filter((item) => !item.is_checked), [items]);
    const checkedItems = useMemo(() => items.filter((item) => item.is_checked), [items]);

    // Articles à acheter, groupés par catégorie (connues d'abord, puis les autres)
    const groups = useMemo(() => {
        const byCategory = new Map<string, ShoppingItem[]>();
        for (const category of ITEM_CATEGORIES) byCategory.set(category, []);
        for (const item of pendingItems) {
            const key = byCategory.has(item.category) ? item.category : item.category || 'other';
            if (!byCategory.has(key)) byCategory.set(key, []);
            byCategory.get(key)!.push(item);
        }
        return Array.from(byCategory.entries()).filter(([, list]) => list.length > 0);
    }, [pendingItems]);

    const itemMeta = (item: ShoppingItem): string => {
        const parts: string[] = [];
        if (item.quantity) {
            parts.push(`${item.quantity}${item.unit ? ` ${item.unit}` : ''}`);
        } else if (item.unit) {
            parts.push(item.unit);
        }
        if (item.notes) parts.push(item.notes);
        return parts.join(' · ');
    };

    if (loading) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="font-medium text-muted-foreground">{t('shopping:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-2xl space-y-5">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div>
                <h1 className="text-h1 text-foreground">{t('shopping:title')}</h1>
                <p className="mt-0.5 text-caption text-muted-foreground">
                    {t('shopping:subtitle', { count: pendingItems.length })}
                </p>
            </div>

            {/* Ajout rapide */}
            {canWriteJournal && (
                <form
                    onSubmit={addItem}
                    className="flex flex-col gap-2 rounded-card border border-border bg-card p-3 shadow-surface sm:flex-row sm:items-center"
                >
                    <Input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder={t('shopping:add.placeholder')}
                        aria-label={t('shopping:add.label')}
                        maxLength={255}
                        className="flex-1"
                    />
                    <div className="flex items-center gap-2">
                        <Select
                            value={newCategory}
                            onValueChange={setNewCategory}
                            options={[
                                { value: '', label: t('shopping:add.noCategory') },
                                ...ITEM_CATEGORIES.map((category) => ({
                                    value: category,
                                    label: categoryLabel(category),
                                })),
                            ]}
                            className="w-44"
                        />
                        <Button type="submit" disabled={adding || !newName.trim()} aria-label={t('common:actions.add')}>
                            <Plus className="h-4 w-4 sm:mr-1.5" />
                            <span className="hidden sm:inline">{t('common:actions.add')}</span>
                        </Button>
                    </div>
                </form>
            )}

            {/* Liste groupée par catégorie */}
            {items.length === 0 ? (
                <EmptyState
                    icon={<ShoppingBasket className="h-10 w-10" />}
                    title={t('shopping:empty.title')}
                    description={canWriteJournal ? t('shopping:empty.description') : undefined}
                />
            ) : (
                <div className="space-y-5">
                    {pendingItems.length === 0 && (
                        <p className="rounded-card border border-dashed border-border bg-card px-4 py-6 text-center text-caption text-muted-foreground">
                            {t('shopping:empty.allChecked')}
                        </p>
                    )}
                    {groups.map(([category, list]) => (
                        <section key={category}>
                            <h2 className="mb-2 px-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                                {categoryLabel(category)}
                            </h2>
                            <ul className="space-y-2">
                                {list.map((item) => (
                                    <li
                                        key={item.id}
                                        className="flex items-center gap-2 rounded-card border border-border bg-card p-2 shadow-surface"
                                    >
                                        <button
                                            type="button"
                                            onClick={() => toggleItem(item)}
                                            disabled={!canWriteJournal}
                                            aria-label={t('shopping:row.check', { name: item.name })}
                                            className={cn(
                                                'flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center rounded-input',
                                                !canWriteJournal && 'cursor-not-allowed opacity-50'
                                            )}
                                        >
                                            <span className="flex h-6 w-6 items-center justify-center rounded-md border-2 border-border-strong bg-card" />
                                        </button>
                                        <div className="min-w-0 flex-1 py-1">
                                            <p className="truncate text-body font-medium text-foreground">{item.name}</p>
                                            {itemMeta(item) && (
                                                <p className="truncate text-micro text-muted-foreground">{itemMeta(item)}</p>
                                            )}
                                        </div>
                                        {canWriteJournal && (
                                            <div className="flex flex-shrink-0 items-center">
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => openEdit(item)}
                                                    aria-label={t('common:actions.edit')}
                                                    className="h-11 w-11 text-muted-foreground"
                                                >
                                                    <Pencil className="h-4 w-4" />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => deleteItem(item.id)}
                                                    aria-label={t('common:actions.delete')}
                                                    className="h-11 w-11 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}

                    {/* Articles cochés */}
                    {checkedItems.length > 0 && (
                        <section className="rounded-card border border-border bg-surface-2/40 p-3">
                            <div className="mb-2 flex items-center justify-between gap-2">
                                <h2 className="text-caption font-medium text-muted-foreground">
                                    {t('shopping:checked.title', { count: checkedItems.length })}
                                </h2>
                                {canWriteJournal && (
                                    <Button variant="ghost" size="sm" onClick={clearChecked}>
                                        {t('shopping:checked.clear')}
                                    </Button>
                                )}
                            </div>
                            <ul className="space-y-1">
                                {checkedItems.map((item) => (
                                    <li key={item.id} className="flex items-center gap-2 rounded-input bg-card px-2 py-1">
                                        <button
                                            type="button"
                                            onClick={() => toggleItem(item)}
                                            disabled={!canWriteJournal}
                                            aria-label={t('shopping:row.uncheck', { name: item.name })}
                                            className={cn(
                                                'flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center',
                                                !canWriteJournal && 'cursor-not-allowed opacity-50'
                                            )}
                                        >
                                            <span className="flex h-5 w-5 items-center justify-center rounded-md border-2 border-primary bg-primary">
                                                <Check className="h-3.5 w-3.5 text-primary-foreground" strokeWidth={3} />
                                            </span>
                                        </button>
                                        <p className="min-w-0 flex-1 truncate text-caption text-muted-foreground line-through">
                                            {item.name}
                                        </p>
                                        {canWriteJournal && (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => deleteItem(item.id)}
                                                aria-label={t('common:actions.delete')}
                                                className="h-11 w-11 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                </div>
            )}

            {/* Édition quantité / unité / note */}
            <Dialog
                open={editingItem !== null}
                onOpenChange={(open) => {
                    if (!open) setEditingItem(null);
                }}
                title={editingItem?.name ?? ''}
                description={t('shopping:edit.description')}
            >
                <form onSubmit={saveEdit} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <Input
                            label={t('shopping:edit.quantity')}
                            type="number"
                            min="0"
                            step="0.1"
                            value={editForm.quantity}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, quantity: e.target.value }))}
                            placeholder="1"
                        />
                        <Input
                            label={t('shopping:edit.unit')}
                            value={editForm.unit}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, unit: e.target.value }))}
                            maxLength={50}
                            placeholder={t('shopping:edit.unitPlaceholder')}
                        />
                    </div>
                    <Textarea
                        label={t('shopping:edit.notes')}
                        value={editForm.notes}
                        onChange={(e) => setEditForm((prev) => ({ ...prev, notes: e.target.value }))}
                        placeholder={t('shopping:edit.notesPlaceholder')}
                        rows={2}
                    />
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setEditingItem(null)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={savingEdit}>
                            {t('common:actions.save')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default ShoppingList;
