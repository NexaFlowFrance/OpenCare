import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';
import {
    ArrowRight,
    ChevronDown,
    ChevronUp,
    Edit2,
    HandCoins,
    Plus,
    Receipt,
    Trash2,
    Wallet,
} from 'lucide-react';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { useAuth } from '../contexts/AuthContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Badge, Button, Card, CardContent, Dialog, DatePicker, Input, Select, Textarea, useToast } from '../components/ui';
import { ChartCard, EmptyState } from '../components/app';
import { dateLocale } from '../i18n/format';

const EXPENSE_CATEGORIES = ['pharmacy', 'aide', 'equipment', 'works', 'food', 'transport', 'other'] as const;
const AID_TYPES = ['apa', 'cesu', 'tax_credit', 'other'] as const;

interface ExpenseSplit {
    member_id: string;
    share: number;
}

interface Expense {
    id: string;
    paid_by: string;
    paid_by_name: string;
    amount: number;
    category: string;
    description: string | null;
    date: string;
    split_mode: 'equal' | 'custom';
    splits: ExpenseSplit[];
}

interface MemberBalance {
    member_id: string;
    name: string;
    role: string;
    color: string;
    total_paid: number;
    total_owed: number;
    balance: number;
}

interface SuggestedSettlement {
    from_member: string;
    to_member: string;
    amount: number;
}

interface Settlement {
    id: string;
    from_member: string;
    to_member: string;
    from_member_name: string;
    to_member_name: string;
    amount: number;
    date: string;
    note: string | null;
}

interface AidRecord {
    id: string;
    type: string;
    label: string | null;
    amount: number;
    period_start: string | null;
    period_end: string | null;
    notes: string | null;
}

interface ExpensesSummary {
    year: number;
    by_category: Array<{ category: string; total: number }>;
    total_expenses: number;
    total_aids: number;
}

interface CircleMember {
    id: string;
    user_id: string;
}

const toCents = (value: number): number => Math.round(value * 100);
const today = (): string => format(new Date(), 'yyyy-MM-dd');

const emptyExpenseForm = {
    amount: '',
    category: 'pharmacy',
    description: '',
    date: today(),
    paid_by: '',
    split_mode: 'equal' as 'equal' | 'custom',
    shares: {} as Record<string, string>,
};

const emptyAidForm = {
    type: 'apa',
    label: '',
    amount: '',
    period_start: '',
    period_end: '',
    notes: '',
};

const Expenses: React.FC = () => {
    const { t, i18n } = useTranslation(['expenses', 'common']);
    const { activeCircle, myRole, canWriteContent, isAdmin } = useCircle();
    const { user } = useAuth();
    const { showToast } = useToast();

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [expenses, setExpenses] = useState<Expense[]>([]);
    const [balances, setBalances] = useState<MemberBalance[]>([]);
    const [suggestions, setSuggestions] = useState<SuggestedSettlement[]>([]);
    const [settlements, setSettlements] = useState<Settlement[]>([]);
    const [aids, setAids] = useState<AidRecord[]>([]);
    const [summary, setSummary] = useState<ExpensesSummary | null>(null);
    const [myMemberId, setMyMemberId] = useState<string | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);

    const [expenseDialogOpen, setExpenseDialogOpen] = useState(false);
    const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
    const [expenseForm, setExpenseForm] = useState(emptyExpenseForm);
    const [formError, setFormError] = useState('');

    const [aidDialogOpen, setAidDialogOpen] = useState(false);
    const [editingAid, setEditingAid] = useState<AidRecord | null>(null);
    const [aidForm, setAidForm] = useState(emptyAidForm);
    const [aidFormError, setAidFormError] = useState('');

    const currency = activeCircle?.currency || 'EUR';
    const formatMoney = useMemo(() => {
        let nf: Intl.NumberFormat;
        try {
            nf = new Intl.NumberFormat(i18n.language, { style: 'currency', currency });
        } catch {
            nf = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'EUR' });
        }
        return (value: number) => nf.format(value);
    }, [i18n.language, currency]);

    const formatDay = (value: string): string =>
        format(parseISO(value), 'd MMM yyyy', { locale: dateLocale() });

    const memberName = (memberId: string): string =>
        balances.find((b) => b.member_id === memberId)?.name ?? '?';

    const categoryLabel = (category: string): string =>
        t(`expenses:categories.${category}`, { defaultValue: category });

    const loadAll = async () => {
        if (!activeCircle || !canWriteContent) {
            setLoading(false);
            return;
        }
        try {
            const [expensesRes, balancesRes, settlementsRes, aidsRes, summaryRes, circleRes] = await Promise.all([
                api.get<{ success: boolean; data: Expense[] }>('/api/expenses'),
                api.get<{ success: boolean; data: { balances: MemberBalance[]; suggested_settlements: SuggestedSettlement[] } }>('/api/expenses/balances'),
                api.get<{ success: boolean; data: Settlement[] }>('/api/expenses/settlements'),
                api.get<{ success: boolean; data: AidRecord[] }>('/api/expenses/aids'),
                api.get<{ success: boolean; data: ExpensesSummary }>('/api/expenses/summary'),
                api.get<{ success: boolean; data: { members: CircleMember[] } }>(`/api/circles/${activeCircle.id}`),
            ]);
            if (expensesRes.success) setExpenses(expensesRes.data);
            if (balancesRes.success) {
                setBalances(balancesRes.data.balances);
                setSuggestions(balancesRes.data.suggested_settlements);
            }
            if (settlementsRes.success) setSettlements(settlementsRes.data);
            if (aidsRes.success) setAids(aidsRes.data);
            if (summaryRes.success) setSummary(summaryRes.data);
            if (circleRes.success) {
                const me = circleRes.data.members.find((m) => m.user_id === user?.id);
                setMyMemberId(me?.id ?? null);
            }
            setError('');
        } catch (err) {
            console.error('Failed to load expenses:', err);
            setError(err instanceof Error ? err.message : t('expenses:errors.load'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        void loadAll();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id, canWriteContent]);

    useWebSocketUpdates('expenses', () => {
        void loadAll();
    });

    // ── Expense form ──────────────────────────────────────────────

    const openCreateExpense = () => {
        setEditingExpense(null);
        setFormError('');
        setExpenseForm({
            ...emptyExpenseForm,
            date: today(),
            paid_by: myMemberId ?? balances[0]?.member_id ?? '',
            shares: {},
        });
        setExpenseDialogOpen(true);
    };

    const openEditExpense = (expense: Expense) => {
        setEditingExpense(expense);
        setFormError('');
        const shares: Record<string, string> = {};
        if (expense.split_mode === 'custom') {
            for (const split of expense.splits) {
                shares[split.member_id] = String(split.share);
            }
        }
        setExpenseForm({
            amount: String(expense.amount),
            category: expense.category,
            description: expense.description ?? '',
            date: expense.date.slice(0, 10),
            paid_by: expense.paid_by,
            split_mode: expense.split_mode,
            shares,
        });
        setExpenseDialogOpen(true);
    };

    const sharesSumCents = useMemo(() => {
        return balances.reduce((acc, member) => {
            const raw = expenseForm.shares[member.member_id];
            const value = raw ? parseFloat(raw) : 0;
            return acc + (Number.isFinite(value) ? toCents(value) : 0);
        }, 0);
    }, [balances, expenseForm.shares]);

    const submitExpense = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError('');

        const amount = parseFloat(expenseForm.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            setFormError(t('expenses:errors.amountInvalid'));
            return;
        }

        const payload: Record<string, unknown> = {
            amount,
            category: expenseForm.category,
            description: expenseForm.description.trim() || null,
            date: expenseForm.date,
            paid_by: expenseForm.paid_by,
            split_mode: expenseForm.split_mode,
        };

        if (expenseForm.split_mode === 'custom') {
            const splits = balances.map((member) => {
                const raw = expenseForm.shares[member.member_id];
                const value = raw ? parseFloat(raw) : 0;
                return { member_id: member.member_id, share: Number.isFinite(value) && value > 0 ? value : 0 };
            });
            const sum = splits.reduce((acc, s) => acc + toCents(s.share), 0);
            if (Math.abs(sum - toCents(amount)) > 1) {
                setFormError(t('expenses:errors.splitSum'));
                return;
            }
            payload.splits = splits;
        }

        try {
            if (editingExpense) {
                await api.put(`/api/expenses/${editingExpense.id}`, payload);
            } else {
                await api.post('/api/expenses', payload);
            }
            setExpenseDialogOpen(false);
            void loadAll();
        } catch (err) {
            console.error('Failed to save expense:', err);
            setFormError(err instanceof Error ? err.message : t('expenses:errors.save'));
        }
    };

    const deleteExpense = async (id: string) => {
        if (!confirm(t('expenses:confirm.deleteExpense'))) return;
        try {
            await api.delete(`/api/expenses/${id}`);
            void loadAll();
        } catch (err) {
            console.error('Failed to delete expense:', err);
            setError(err instanceof Error ? err.message : t('expenses:errors.delete'));
        }
    };

    // ── Settlements ───────────────────────────────────────────────

    const markSettled = async (suggestion: SuggestedSettlement) => {
        try {
            await api.post('/api/expenses/settlements', {
                from_member: suggestion.from_member,
                to_member: suggestion.to_member,
                amount: suggestion.amount,
                date: today(),
            });
            showToast({ title: t('expenses:balances.settledToast') });
            void loadAll();
        } catch (err) {
            console.error('Failed to create settlement:', err);
            setError(err instanceof Error ? err.message : t('expenses:errors.saveSettlement'));
        }
    };

    const deleteSettlement = async (id: string) => {
        if (!confirm(t('expenses:confirm.deleteSettlement'))) return;
        try {
            await api.delete(`/api/expenses/settlements/${id}`);
            void loadAll();
        } catch (err) {
            console.error('Failed to delete settlement:', err);
            setError(err instanceof Error ? err.message : t('expenses:errors.delete'));
        }
    };

    // ── Aids ──────────────────────────────────────────────────────

    const openCreateAid = () => {
        setEditingAid(null);
        setAidFormError('');
        setAidForm(emptyAidForm);
        setAidDialogOpen(true);
    };

    const openEditAid = (aid: AidRecord) => {
        setEditingAid(aid);
        setAidFormError('');
        setAidForm({
            type: aid.type,
            label: aid.label ?? '',
            amount: String(aid.amount),
            period_start: aid.period_start ? aid.period_start.slice(0, 10) : '',
            period_end: aid.period_end ? aid.period_end.slice(0, 10) : '',
            notes: aid.notes ?? '',
        });
        setAidDialogOpen(true);
    };

    const submitAid = async (e: React.FormEvent) => {
        e.preventDefault();
        setAidFormError('');

        const amount = parseFloat(aidForm.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            setAidFormError(t('expenses:errors.amountInvalid'));
            return;
        }

        const payload = {
            type: aidForm.type,
            label: aidForm.label.trim() || null,
            amount,
            period_start: aidForm.period_start || null,
            period_end: aidForm.period_end || null,
            notes: aidForm.notes.trim() || null,
        };

        try {
            if (editingAid) {
                await api.put(`/api/expenses/aids/${editingAid.id}`, payload);
            } else {
                await api.post('/api/expenses/aids', payload);
            }
            setAidDialogOpen(false);
            void loadAll();
        } catch (err) {
            console.error('Failed to save aid:', err);
            setAidFormError(err instanceof Error ? err.message : t('expenses:errors.saveAid'));
        }
    };

    const deleteAid = async (id: string) => {
        if (!confirm(t('expenses:confirm.deleteAid'))) return;
        try {
            await api.delete(`/api/expenses/aids/${id}`);
            void loadAll();
        } catch (err) {
            console.error('Failed to delete aid:', err);
            setError(err instanceof Error ? err.message : t('expenses:errors.delete'));
        }
    };

    const aidPeriod = (aid: AidRecord): string | null => {
        if (aid.period_start && aid.period_end) {
            return t('expenses:aids.periodBoth', { start: formatDay(aid.period_start), end: formatDay(aid.period_end) });
        }
        if (aid.period_start) return t('expenses:aids.periodFrom', { start: formatDay(aid.period_start) });
        if (aid.period_end) return t('expenses:aids.periodTo', { end: formatDay(aid.period_end) });
        return null;
    };

    // ── Render ────────────────────────────────────────────────────

    // myRole is null while the circle list loads: show the spinner, not the restricted state.
    if (myRole !== null && !canWriteContent) {
        return (
            <div className="mx-auto max-w-3xl">
                <EmptyState
                    icon={<Wallet className="h-10 w-10" />}
                    title={t('expenses:restricted.title')}
                    description={t('expenses:restricted.description')}
                />
            </div>
        );
    }

    if (loading || !activeCircle) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="animate-pulse font-medium text-muted-foreground">{t('expenses:loading')}</p>
                </div>
            </div>
        );
    }

    const maxCategoryTotal = Math.max(1, ...(summary?.by_category.map((c) => c.total) ?? [0]));

    return (
        <div className="mx-auto max-w-6xl space-y-6">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
                <div>
                    <h1 className="mb-1 text-h1">{t('expenses:title')}</h1>
                    <p className="text-body text-muted-foreground">{t('expenses:subtitle')}</p>
                </div>
                <Button onClick={openCreateExpense}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('expenses:newExpense')}
                </Button>
            </div>

            {/* Balances */}
            <ChartCard title={t('expenses:balances.title')} subtitle={t('expenses:balances.subtitle')}>
                <div className="space-y-2">
                    {balances.map((member) => (
                        <div
                            key={member.member_id}
                            className="flex min-h-[48px] flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-input bg-surface-2/50 px-3 py-2"
                        >
                            <div className="flex items-center gap-2">
                                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: member.color }} />
                                <span className="text-body font-medium">{member.name}</span>
                            </div>
                            <div className="flex items-center gap-4 text-caption">
                                <span className="text-muted-foreground">
                                    {t('expenses:balances.paid')} {formatMoney(member.total_paid)}
                                </span>
                                <span className="text-muted-foreground">
                                    {t('expenses:balances.owed')} {formatMoney(member.total_owed)}
                                </span>
                                <span
                                    className={`font-semibold ${member.balance > 0 ? 'text-success' : member.balance < 0 ? 'text-danger' : 'text-muted-foreground'}`}
                                >
                                    {member.balance > 0 ? '+' : ''}
                                    {formatMoney(member.balance)}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>

                <div className="mt-5 border-t border-border pt-4">
                    <h3 className="mb-3 text-label font-medium text-muted-foreground">
                        {t('expenses:balances.settleTitle')}
                    </h3>
                    {suggestions.length === 0 ? (
                        <p className="text-caption text-muted-foreground">{t('expenses:balances.allSettled')}</p>
                    ) : (
                        <div className="space-y-2">
                            {suggestions.map((suggestion, index) => (
                                <div
                                    key={`${suggestion.from_member}-${suggestion.to_member}-${index}`}
                                    className="flex flex-wrap items-center justify-between gap-3 rounded-input border border-border px-3 py-2"
                                >
                                    <span className="flex items-center gap-2 text-body-sm">
                                        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        {t('expenses:balances.suggestion', {
                                            from: memberName(suggestion.from_member),
                                            to: memberName(suggestion.to_member),
                                            amount: formatMoney(suggestion.amount),
                                        })}
                                    </span>
                                    <Button variant="secondary" size="sm" onClick={() => void markSettled(suggestion)}>
                                        <HandCoins className="mr-2 h-4 w-4" />
                                        {t('expenses:balances.markSettled')}
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </ChartCard>

            {/* Expense list */}
            <section className="space-y-3">
                <h2 className="text-h2 font-semibold">{t('expenses:list.title')}</h2>
                {expenses.length === 0 ? (
                    <EmptyState
                        icon={<Receipt className="h-10 w-10" />}
                        title={t('expenses:list.empty')}
                        actionLabel={t('expenses:newExpense')}
                        onAction={openCreateExpense}
                    />
                ) : (
                    expenses.map((expense) => {
                        const canManage = isAdmin || expense.paid_by === myMemberId;
                        return (
                            <Card key={expense.id} hover={false}>
                                <CardContent className="p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="text-body font-semibold">
                                                    {expense.description || categoryLabel(expense.category)}
                                                </span>
                                                <Badge variant="primary">{categoryLabel(expense.category)}</Badge>
                                                {expense.split_mode === 'custom' ? (
                                                    <Badge variant="secondary">{t('expenses:list.customSplit')}</Badge>
                                                ) : null}
                                            </div>
                                            <p className="mt-1 text-caption text-muted-foreground">
                                                {formatDay(expense.date)} · {t('expenses:list.paidBy', { name: expense.paid_by_name })}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <span className="mr-2 font-serif text-xl tracking-tight">{formatMoney(expense.amount)}</span>
                                            {canManage ? (
                                                <>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={t('common:actions.edit')}
                                                        onClick={() => openEditExpense(expense)}
                                                    >
                                                        <Edit2 className="h-4 w-4" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={t('common:actions.delete')}
                                                        onClick={() => void deleteExpense(expense.id)}
                                                    >
                                                        <Trash2 className="h-4 w-4 text-danger" />
                                                    </Button>
                                                </>
                                            ) : null}
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })
                )}
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
                {/* Aids */}
                <ChartCard
                    title={t('expenses:aids.title')}
                    subtitle={t('expenses:aids.subtitle')}
                    action={
                        <Button variant="secondary" size="sm" onClick={openCreateAid}>
                            <Plus className="mr-2 h-4 w-4" />
                            {t('expenses:aids.add')}
                        </Button>
                    }
                >
                    {aids.length === 0 ? (
                        <p className="text-caption text-muted-foreground">{t('expenses:aids.empty')}</p>
                    ) : (
                        <div className="space-y-2">
                            {aids.map((aid) => (
                                <div
                                    key={aid.id}
                                    className="flex items-start justify-between gap-3 rounded-input bg-surface-2/50 px-3 py-2"
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge variant="success">{t(`expenses:aids.types.${aid.type}`, { defaultValue: aid.type })}</Badge>
                                            {aid.label ? <span className="text-body-sm font-medium">{aid.label}</span> : null}
                                        </div>
                                        {aidPeriod(aid) ? (
                                            <p className="mt-1 text-micro text-muted-foreground">{aidPeriod(aid)}</p>
                                        ) : null}
                                        {aid.notes ? (
                                            <p className="mt-0.5 text-micro text-muted-foreground">{aid.notes}</p>
                                        ) : null}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <span className="mr-1 text-body-sm font-semibold">{formatMoney(aid.amount)}</span>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={t('common:actions.edit')}
                                            onClick={() => openEditAid(aid)}
                                        >
                                            <Edit2 className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={t('common:actions.delete')}
                                            onClick={() => void deleteAid(aid.id)}
                                        >
                                            <Trash2 className="h-4 w-4 text-danger" />
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    {summary ? (
                        <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-body-sm">
                            <span className="text-muted-foreground">{t('expenses:aids.yearTotal', { year: summary.year })}</span>
                            <span className="font-semibold text-success">{formatMoney(summary.total_aids)}</span>
                        </div>
                    ) : null}
                </ChartCard>

                {/* Annual summary */}
                {summary ? (
                    <ChartCard
                        title={t('expenses:summary.title', { year: summary.year })}
                        subtitle={t('expenses:summary.subtitle')}
                    >
                        {summary.by_category.length === 0 ? (
                            <p className="text-caption text-muted-foreground">{t('expenses:summary.empty')}</p>
                        ) : (
                            <div className="space-y-3">
                                {summary.by_category.map((item) => (
                                    <div key={item.category}>
                                        <div className="mb-1 flex items-center justify-between text-caption">
                                            <span>{categoryLabel(item.category)}</span>
                                            <span className="font-medium">{formatMoney(item.total)}</span>
                                        </div>
                                        <div className="h-2 overflow-hidden rounded-pill bg-surface-2">
                                            <div
                                                className="h-full rounded-pill bg-primary/70"
                                                style={{ width: `${Math.max(3, (item.total / maxCategoryTotal) * 100)}%` }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="mt-4 space-y-1 border-t border-border pt-3 text-body-sm">
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">{t('expenses:summary.totalExpenses')}</span>
                                <span className="font-semibold">{formatMoney(summary.total_expenses)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">{t('expenses:summary.totalAids')}</span>
                                <span className="font-semibold text-success">{formatMoney(summary.total_aids)}</span>
                            </div>
                        </div>
                    </ChartCard>
                ) : null}
            </div>

            {/* Settlement history */}
            <Card hover={false}>
                <CardContent className="p-4">
                    <button
                        type="button"
                        onClick={() => setHistoryOpen((open) => !open)}
                        className="flex min-h-[44px] w-full items-center justify-between text-left"
                        aria-expanded={historyOpen}
                    >
                        <span className="text-body font-semibold">{t('expenses:settlements.title')}</span>
                        <span className="flex items-center gap-1 text-caption text-muted-foreground">
                            {historyOpen ? t('expenses:settlements.hide') : t('expenses:settlements.show')}
                            {historyOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </span>
                    </button>
                    {historyOpen ? (
                        settlements.length === 0 ? (
                            <p className="mt-3 text-caption text-muted-foreground">{t('expenses:settlements.empty')}</p>
                        ) : (
                            <div className="mt-3 space-y-2">
                                {settlements.map((settlement) => (
                                    <div
                                        key={settlement.id}
                                        className="flex flex-wrap items-center justify-between gap-2 rounded-input bg-surface-2/50 px-3 py-2"
                                    >
                                        <div className="min-w-0">
                                            <p className="text-body-sm">
                                                {t('expenses:settlements.row', {
                                                    from: settlement.from_member_name,
                                                    to: settlement.to_member_name,
                                                })}
                                            </p>
                                            <p className="text-micro text-muted-foreground">
                                                {formatDay(settlement.date)}
                                                {settlement.note ? ` · ${settlement.note}` : ''}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <span className="text-body-sm font-semibold">{formatMoney(settlement.amount)}</span>
                                            {(isAdmin || settlement.from_member === myMemberId) ? (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t('common:actions.delete')}
                                                    onClick={() => void deleteSettlement(settlement.id)}
                                                >
                                                    <Trash2 className="h-4 w-4 text-danger" />
                                                </Button>
                                            ) : null}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )
                    ) : null}
                </CardContent>
            </Card>

            {/* Expense dialog */}
            <Dialog
                open={expenseDialogOpen}
                onOpenChange={setExpenseDialogOpen}
                title={editingExpense ? t('expenses:dialog.editTitle') : t('expenses:dialog.createTitle')}
                description={t('expenses:dialog.description')}
            >
                <form onSubmit={submitExpense} className="space-y-4">
                    {formError ? (
                        <div className="rounded-input border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">
                            {formError}
                        </div>
                    ) : null}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Input
                            label={t('expenses:form.amount', { currency })}
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min="0.01"
                            required
                            value={expenseForm.amount}
                            onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })}
                        />
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('expenses:form.category')}
                            </label>
                            <Select
                                value={expenseForm.category}
                                onValueChange={(value) => setExpenseForm({ ...expenseForm, category: value })}
                                options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
                            />
                        </div>
                    </div>
                    <Input
                        label={t('expenses:form.descriptionLabel')}
                        value={expenseForm.description}
                        onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })}
                        placeholder={t('expenses:form.descriptionPlaceholder')}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <DatePicker
                            label={t('expenses:form.date')}
                            value={expenseForm.date}
                            onChange={(value) => setExpenseForm({ ...expenseForm, date: value })}
                        />
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('expenses:form.paidBy')}
                            </label>
                            <Select
                                value={expenseForm.paid_by}
                                onValueChange={(value) => setExpenseForm({ ...expenseForm, paid_by: value })}
                                options={balances.map((m) => ({ value: m.member_id, label: m.name }))}
                            />
                        </div>
                    </div>
                    <div>
                        <label className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('expenses:form.split')}
                        </label>
                        <div className="flex gap-2">
                            {(['equal', 'custom'] as const).map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    onClick={() => setExpenseForm({ ...expenseForm, split_mode: mode })}
                                    className={`min-h-[44px] rounded-pill border px-4 text-caption font-medium transition-colors ${
                                        expenseForm.split_mode === mode
                                            ? 'border-primary bg-primary-soft text-primary'
                                            : 'border-border bg-surface text-muted-foreground hover:border-border-strong'
                                    }`}
                                >
                                    {mode === 'equal' ? t('expenses:form.splitEqual') : t('expenses:form.splitCustom')}
                                </button>
                            ))}
                        </div>
                    </div>
                    {expenseForm.split_mode === 'custom' ? (
                        <div className="space-y-2 rounded-input border border-border bg-surface-2/40 p-3">
                            {balances.map((member) => (
                                <div key={member.member_id} className="flex items-center gap-3">
                                    <span className="w-1/3 truncate text-caption">{member.name}</span>
                                    <Input
                                        aria-label={t('expenses:form.shareOf', { name: member.name })}
                                        type="number"
                                        inputMode="decimal"
                                        step="0.01"
                                        min="0"
                                        value={expenseForm.shares[member.member_id] ?? ''}
                                        onChange={(e) =>
                                            setExpenseForm({
                                                ...expenseForm,
                                                shares: { ...expenseForm.shares, [member.member_id]: e.target.value },
                                            })
                                        }
                                    />
                                </div>
                            ))}
                            <p
                                className={`pt-1 text-micro ${
                                    Math.abs(sharesSumCents - toCents(parseFloat(expenseForm.amount) || 0)) <= 1
                                        ? 'text-success'
                                        : 'text-danger'
                                }`}
                            >
                                {t('expenses:form.splitTotal', {
                                    sum: formatMoney(sharesSumCents / 100),
                                    total: formatMoney(parseFloat(expenseForm.amount) || 0),
                                })}
                            </p>
                        </div>
                    ) : null}
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setExpenseDialogOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit">
                            {editingExpense ? t('common:actions.save') : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>

            {/* Aid dialog */}
            <Dialog
                open={aidDialogOpen}
                onOpenChange={setAidDialogOpen}
                title={editingAid ? t('expenses:aids.editTitle') : t('expenses:aids.createTitle')}
            >
                <form onSubmit={submitAid} className="space-y-4">
                    {aidFormError ? (
                        <div className="rounded-input border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">
                            {aidFormError}
                        </div>
                    ) : null}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('expenses:aids.form.type')}
                            </label>
                            <Select
                                value={aidForm.type}
                                onValueChange={(value) => setAidForm({ ...aidForm, type: value })}
                                options={AID_TYPES.map((type) => ({
                                    value: type,
                                    label: t(`expenses:aids.types.${type}`, { defaultValue: type }),
                                }))}
                            />
                        </div>
                        <Input
                            label={t('expenses:aids.form.amount', { currency })}
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min="0.01"
                            required
                            value={aidForm.amount}
                            onChange={(e) => setAidForm({ ...aidForm, amount: e.target.value })}
                        />
                    </div>
                    <Input
                        label={t('expenses:aids.form.label')}
                        value={aidForm.label}
                        onChange={(e) => setAidForm({ ...aidForm, label: e.target.value })}
                        placeholder={t('expenses:aids.form.labelPlaceholder')}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <DatePicker
                            label={t('expenses:aids.form.periodStart')}
                            value={aidForm.period_start}
                            onChange={(value) => setAidForm({ ...aidForm, period_start: value })}
                        />
                        <DatePicker
                            label={t('expenses:aids.form.periodEnd')}
                            value={aidForm.period_end}
                            onChange={(value) => setAidForm({ ...aidForm, period_end: value })}
                        />
                    </div>
                    <Textarea
                        label={t('expenses:aids.form.notes')}
                        rows={2}
                        value={aidForm.notes}
                        onChange={(e) => setAidForm({ ...aidForm, notes: e.target.value })}
                    />
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setAidDialogOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit">
                            {editingAid ? t('common:actions.save') : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Expenses;
