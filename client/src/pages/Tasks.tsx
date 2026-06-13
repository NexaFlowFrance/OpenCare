import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';
import { Plus, Check, ClipboardList, Pencil, Trash2, Repeat, ChevronDown, ChevronRight, CalendarClock } from 'lucide-react';
import { api } from '../lib/api';
import { useCircle } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { dateLocale } from '../i18n/format';
import { Button, Dialog, Input, Select, Textarea, DatePicker, Badge } from '../components/ui';
import { EmptyState } from '../components/app';
import { cn } from '../lib/utils';

// Catégories normalisées côté serveur (tasks.ts: TASK_CATEGORIES)
const TASK_CATEGORIES = ['shopping', 'pharmacy', 'laundry', 'admin', 'transport', 'other'] as const;

// Valeurs historiques de frequency / priority (stockées telles quelles en base)
const FREQUENCY_VALUES = ['Une fois', 'Quotidien', 'Hebdomadaire', 'Mensuel', 'Annuel'] as const;
const PRIORITY_VALUES = ['Haute', 'Moyenne', 'Basse'] as const;

interface AssignedMember {
    id: string;
    name: string;
    color: string;
}

interface Task {
    id: string;
    title: string;
    description?: string | null;
    category: string;
    is_completed: boolean;
    due_date?: string | null;
    frequency?: string | null;
    priority?: string | null;
    assigned_to: string[];
    assigned_to_members: AssignedMember[];
    completed_at?: string | null;
    created_at: string;
}

interface CircleMember {
    id: string;
    user_id: string;
    name: string;
    color: string;
    role: string;
}

type StatusFilter = 'todo' | 'done' | 'all';

const initials = (name: string): string =>
    name
        .trim()
        .split(/\s+/)
        .map((part) => part[0] ?? '')
        .slice(0, 2)
        .join('')
        .toUpperCase();

/** Date locale du jour au format yyyy-MM-dd, pour comparer sans décalage UTC. */
const todayLocal = (): string => format(new Date(), 'yyyy-MM-dd');

/** due_date arrive soit en yyyy-MM-dd, soit en datetime naïf: les 10 premiers
 *  caractères sont toujours la date locale (pas d'aller-retour par Date). */
const dueDatePart = (dueDate: string): string => dueDate.slice(0, 10);

const MemberAvatar: React.FC<{ member: AssignedMember; className?: string }> = ({ member, className }) => (
    <span
        title={member.name}
        className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full border-2 bg-surface-2 text-micro font-semibold text-foreground',
            className
        )}
        style={{ borderColor: member.color }}
    >
        {initials(member.name)}
    </span>
);

const Tasks: React.FC = () => {
    const { t } = useTranslation(['tasks', 'common']);
    const { activeCircle, canWriteContent, canWriteJournal } = useCircle();

    const [tasks, setTasks] = useState<Task[]>([]);
    const [members, setMembers] = useState<CircleMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [statusFilter, setStatusFilter] = useState<StatusFilter>('todo');
    const [assigneeFilter, setAssigneeFilter] = useState('');
    const [completedOpen, setCompletedOpen] = useState(false);

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [saving, setSaving] = useState(false);
    const [formData, setFormData] = useState({
        title: '',
        description: '',
        category: 'other',
        due_date: '',
        priority: 'Moyenne',
        frequency: 'Une fois',
        assigned_to: [] as string[],
    });

    const categoryLabel = (value: string) => t(`tasks:categories.${value}`, { defaultValue: value });
    const frequencyLabel = (value: string) => t(`tasks:frequencies.${value}`, { defaultValue: value });
    const priorityLabel = (value: string) => t(`tasks:priorities.${value}`, { defaultValue: value });

    const loadTasks = async () => {
        try {
            const response = await api.get<{ success: boolean; data: Task[] }>('/api/tasks');
            if (response.success) {
                setTasks(response.data);
                setError('');
            }
        } catch (err) {
            console.error('Failed to load tasks:', err);
            setError(err instanceof Error ? err.message : t('tasks:errors.load'));
        }
    };

    const loadMembers = async (circleId: string) => {
        try {
            const response = await api.get<{ success: boolean; data: { members: CircleMember[] } }>(
                `/api/circles/${circleId}`
            );
            if (response.success) {
                setMembers(response.data.members ?? []);
            }
        } catch (err) {
            console.error('Failed to load circle members:', err);
            setError(err instanceof Error ? err.message : t('tasks:errors.loadMembers'));
        }
    };

    // Recharge quand le cercle actif change
    useEffect(() => {
        if (!activeCircle?.id) return;
        setLoading(true);
        setAssigneeFilter('');
        void Promise.all([loadTasks(), loadMembers(activeCircle.id)]).finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCircle?.id]);

    useWebSocketUpdates('tasks', () => {
        void loadTasks();
    });

    const handleToggleComplete = async (task: Task) => {
        if (!canWriteJournal) return;
        setError('');
        try {
            const response = await api.put<{ success: boolean; data: Task }>(
                `/api/tasks/${task.id}/complete`,
                { is_completed: !task.is_completed }
            );
            // response.data peut être null si l'écriture est partie en file hors ligne:
            // on bascule alors l'état localement en attendant la synchronisation.
            if (response.success && response.data) {
                setTasks((prev) => prev.map((current) => (current.id === task.id ? response.data : current)));
            } else if (response.success) {
                setTasks((prev) => prev.map((current) => (
                    current.id === task.id ? { ...current, is_completed: !task.is_completed } : current
                )));
            }
        } catch (err) {
            console.error('Failed to toggle task:', err);
            setError(err instanceof Error ? err.message : t('tasks:errors.toggle'));
        }
    };

    const resetForm = () => {
        setEditingTask(null);
        setFormData({
            title: '',
            description: '',
            category: 'other',
            due_date: '',
            priority: 'Moyenne',
            frequency: 'Une fois',
            assigned_to: [],
        });
    };

    const openCreate = () => {
        resetForm();
        setDialogOpen(true);
    };

    const openEdit = (task: Task) => {
        setEditingTask(task);
        setFormData({
            title: task.title,
            description: task.description || '',
            category: task.category || 'other',
            due_date: task.due_date ? dueDatePart(task.due_date) : '',
            priority: task.priority || 'Moyenne',
            frequency: task.frequency || 'Une fois',
            assigned_to: task.assigned_to || [],
        });
        setDialogOpen(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setSaving(true);
        try {
            const payload = {
                title: formData.title,
                description: formData.description,
                category: formData.category,
                due_date: formData.due_date,
                priority: formData.priority,
                frequency: formData.frequency,
                assigned_to: formData.assigned_to,
            };
            if (editingTask) {
                await api.put(`/api/tasks/${editingTask.id}`, payload);
            } else {
                await api.post('/api/tasks', payload);
            }
            setDialogOpen(false);
            resetForm();
            await loadTasks();
        } catch (err) {
            console.error('Failed to save task:', err);
            setError(err instanceof Error ? err.message : t('tasks:errors.save'));
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (task: Task) => {
        if (!window.confirm(t('tasks:confirmDelete'))) return;
        setError('');
        try {
            await api.delete(`/api/tasks/${task.id}`);
            setTasks((prev) => prev.filter((current) => current.id !== task.id));
        } catch (err) {
            console.error('Failed to delete task:', err);
            setError(err instanceof Error ? err.message : t('tasks:errors.delete'));
        }
    };

    const toggleAssignee = (memberId: string) => {
        setFormData((prev) => ({
            ...prev,
            assigned_to: prev.assigned_to.includes(memberId)
                ? prev.assigned_to.filter((id) => id !== memberId)
                : [...prev.assigned_to, memberId],
        }));
    };

    const filteredTasks = useMemo(
        () => tasks.filter((task) => !assigneeFilter || (task.assigned_to || []).includes(assigneeFilter)),
        [tasks, assigneeFilter]
    );
    const openTasks = useMemo(() => filteredTasks.filter((task) => !task.is_completed), [filteredTasks]);
    const doneTasks = useMemo(() => filteredTasks.filter((task) => task.is_completed), [filteredTasks]);

    const mainList =
        statusFilter === 'done' ? doneTasks : statusFilter === 'all' ? [...openTasks, ...doneTasks] : openTasks;
    const showCompletedSection = statusFilter === 'todo' && doneTasks.length > 0;
    const today = todayLocal();

    const renderTaskRow = (task: Task) => {
        const due = task.due_date ? dueDatePart(task.due_date) : null;
        const isOverdue = Boolean(due && !task.is_completed && due < today);
        const hasRecurrence = Boolean(task.frequency && task.frequency !== 'Une fois');

        return (
            <li
                key={task.id}
                className={cn(
                    'flex items-start gap-2 rounded-card border border-border bg-card p-3 shadow-surface sm:p-4',
                    task.is_completed && 'bg-muted/30'
                )}
            >
                <button
                    type="button"
                    onClick={() => handleToggleComplete(task)}
                    disabled={!canWriteJournal}
                    aria-label={task.is_completed ? t('tasks:row.markPending') : t('tasks:row.markDone')}
                    aria-pressed={task.is_completed}
                    className={cn(
                        'flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center rounded-input',
                        !canWriteJournal && 'cursor-not-allowed opacity-50'
                    )}
                >
                    <span
                        className={cn(
                            'flex h-6 w-6 items-center justify-center rounded-md border-2 transition-colors duration-fast ease-soft',
                            task.is_completed ? 'border-primary bg-primary' : 'border-border-strong bg-card'
                        )}
                    >
                        {task.is_completed && <Check className="h-4 w-4 text-primary-foreground" strokeWidth={3} />}
                    </span>
                </button>

                <div className="min-w-0 flex-1 py-1.5">
                    <p
                        className={cn(
                            'text-body font-medium text-foreground',
                            task.is_completed && 'text-muted-foreground line-through'
                        )}
                    >
                        {task.title}
                    </p>
                    {task.description && (
                        <p className="mt-0.5 text-caption text-muted-foreground">{task.description}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                        <Badge variant="secondary">{categoryLabel(task.category)}</Badge>
                        {task.priority === 'Haute' && !task.is_completed && (
                            <Badge variant="warning">{priorityLabel(task.priority)}</Badge>
                        )}
                        {due && (
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1 text-micro',
                                    isOverdue ? 'font-medium text-danger' : 'text-muted-foreground'
                                )}
                            >
                                <CalendarClock className="h-3.5 w-3.5" />
                                {isOverdue
                                    ? t('tasks:row.overdue', {
                                          date: format(parseISO(due), 'd MMM', { locale: dateLocale() }),
                                      })
                                    : t('tasks:row.due', {
                                          date: format(parseISO(due), 'd MMM', { locale: dateLocale() }),
                                      })}
                            </span>
                        )}
                        {hasRecurrence && (
                            <span className="inline-flex items-center gap-1 text-micro text-muted-foreground">
                                <Repeat className="h-3.5 w-3.5" />
                                {frequencyLabel(task.frequency!)}
                            </span>
                        )}
                        {(task.assigned_to_members || []).length > 0 && (
                            <span className="flex items-center -space-x-1.5">
                                {task.assigned_to_members.map((member) => (
                                    <MemberAvatar key={member.id} member={member} className="border-card ring-1 ring-border" />
                                ))}
                            </span>
                        )}
                    </div>
                </div>

                {canWriteContent && (
                    <div className="flex flex-shrink-0 items-center">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEdit(task)}
                            aria-label={t('common:actions.edit')}
                            className="h-11 w-11 text-muted-foreground"
                        >
                            <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(task)}
                            aria-label={t('common:actions.delete')}
                            className="h-11 w-11 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                        >
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    </div>
                )}
            </li>
        );
    };

    if (loading) {
        return (
            <div className="flex h-full min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="font-medium text-muted-foreground">{t('tasks:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-3xl space-y-5">
            {error ? (
                <div className="rounded-input border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
                    {error}
                </div>
            ) : null}

            <div className="flex items-start justify-between gap-3">
                <div>
                    <h1 className="text-h1 text-foreground">{t('tasks:title')}</h1>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                        {t('tasks:subtitle', { count: openTasks.length })}
                    </p>
                </div>
                {canWriteContent && (
                    <Button onClick={openCreate}>
                        <Plus className="mr-1.5 h-4 w-4" />
                        {t('tasks:newTask')}
                    </Button>
                )}
            </div>

            {/* Filtres: statut + assigné */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div
                    role="group"
                    aria-label={t('tasks:filters.statusLabel')}
                    className="inline-flex min-h-[44px] rounded-pill bg-surface-2 p-1"
                >
                    {(['todo', 'done', 'all'] as StatusFilter[]).map((status) => (
                        <button
                            key={status}
                            type="button"
                            onClick={() => setStatusFilter(status)}
                            aria-pressed={statusFilter === status}
                            className={cn(
                                'min-h-[36px] flex-1 rounded-pill px-4 text-caption font-medium transition-colors duration-fast ease-soft sm:flex-none',
                                statusFilter === status
                                    ? 'bg-card text-primary shadow-surface'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t(`tasks:filters.${status}`)}
                        </button>
                    ))}
                </div>
                <Select
                    value={assigneeFilter}
                    onValueChange={setAssigneeFilter}
                    options={[
                        { value: '', label: t('tasks:filters.allAssignees') },
                        ...members.map((member) => ({ value: member.id, label: member.name })),
                    ]}
                    className="w-full sm:w-56"
                />
            </div>

            {/* Liste principale */}
            {mainList.length === 0 ? (
                <EmptyState
                    icon={<ClipboardList className="h-10 w-10" />}
                    title={
                        statusFilter === 'done'
                            ? t('tasks:empty.doneTitle')
                            : tasks.length === 0
                              ? t('tasks:empty.title')
                              : t('tasks:empty.noMatch')
                    }
                    description={
                        statusFilter !== 'done' && tasks.length === 0 && canWriteContent
                            ? t('tasks:empty.description')
                            : undefined
                    }
                    actionLabel={
                        statusFilter !== 'done' && tasks.length === 0 && canWriteContent
                            ? t('tasks:newTask')
                            : undefined
                    }
                    onAction={statusFilter !== 'done' && tasks.length === 0 && canWriteContent ? openCreate : undefined}
                />
            ) : (
                <ul className="space-y-2">{mainList.map(renderTaskRow)}</ul>
            )}

            {/* Tâches terminées (section repliée) */}
            {showCompletedSection && (
                <section className="rounded-card border border-border bg-surface-2/40">
                    <button
                        type="button"
                        onClick={() => setCompletedOpen((open) => !open)}
                        aria-expanded={completedOpen}
                        className="flex min-h-[48px] w-full items-center gap-2 px-4 py-3 text-left"
                    >
                        {completedOpen ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="text-caption font-medium text-muted-foreground">
                            {t('tasks:completedSection', { count: doneTasks.length })}
                        </span>
                    </button>
                    {completedOpen && <ul className="space-y-2 px-3 pb-3">{doneTasks.map(renderTaskRow)}</ul>}
                </section>
            )}

            {/* Création / édition */}
            <Dialog
                open={dialogOpen}
                onOpenChange={(open) => {
                    setDialogOpen(open);
                    if (!open) resetForm();
                }}
                title={editingTask ? t('tasks:dialog.editTitle') : t('tasks:dialog.createTitle')}
                description={t('tasks:dialog.description')}
            >
                <form onSubmit={handleSubmit} className="space-y-4">
                    <Input
                        label={t('tasks:form.title')}
                        value={formData.title}
                        onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
                        required
                        maxLength={255}
                        placeholder={t('tasks:form.titlePlaceholder')}
                    />
                    <Textarea
                        label={t('tasks:form.description')}
                        value={formData.description}
                        onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                        placeholder={t('tasks:form.descriptionPlaceholder')}
                        rows={3}
                    />
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('tasks:form.category')}
                            </label>
                            <Select
                                value={formData.category}
                                onValueChange={(value) => setFormData((prev) => ({ ...prev, category: value }))}
                                options={TASK_CATEGORIES.map((category) => ({
                                    value: category,
                                    label: categoryLabel(category),
                                }))}
                            />
                        </div>
                        <DatePicker
                            label={t('tasks:form.dueDate')}
                            value={formData.due_date}
                            onChange={(value) => setFormData((prev) => ({ ...prev, due_date: value }))}
                        />
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('tasks:form.priority')}
                            </label>
                            <Select
                                value={formData.priority}
                                onValueChange={(value) => setFormData((prev) => ({ ...prev, priority: value }))}
                                options={PRIORITY_VALUES.map((priority) => ({
                                    value: priority,
                                    label: priorityLabel(priority),
                                }))}
                            />
                        </div>
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('tasks:form.frequency')}
                            </label>
                            <Select
                                value={formData.frequency}
                                onValueChange={(value) => setFormData((prev) => ({ ...prev, frequency: value }))}
                                options={FREQUENCY_VALUES.map((frequency) => ({
                                    value: frequency,
                                    label: frequencyLabel(frequency),
                                }))}
                            />
                        </div>
                    </div>
                    <div>
                        <span className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('tasks:form.assignees')}
                        </span>
                        {members.length === 0 ? (
                            <p className="text-caption text-muted-foreground">{t('tasks:form.noMembers')}</p>
                        ) : (
                            <div className="space-y-1 rounded-input border border-border bg-surface-2/40 p-2">
                                {members.map((member) => (
                                    <label
                                        key={member.id}
                                        className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-input px-2 hover:bg-surface-2"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={formData.assigned_to.includes(member.id)}
                                            onChange={() => toggleAssignee(member.id)}
                                            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                                        />
                                        <MemberAvatar member={member} />
                                        <span className="text-caption text-foreground">{member.name}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="flex justify-end gap-3 pt-2">
                        <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={saving || !formData.title.trim()}>
                            {editingTask ? t('common:actions.save') : t('common:actions.create')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default Tasks;
