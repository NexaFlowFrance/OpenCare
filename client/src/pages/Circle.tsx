import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
    Copy, Link2, LogOut, Mail, Plus, RotateCcw, Ban, Trash2, UserMinus,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useCircle, CircleRole } from '../contexts/CircleContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import {
    Card, CardHeader, CardTitle, CardContent,
    Button, Input, Select, Dialog, Badge, useToast,
} from '../components/ui';
import { formatDate } from '../lib/utils';

const ROLES: CircleRole[] = ['admin', 'family', 'professional', 'neighbor', 'viewer'];
const CURRENCIES = ['EUR', 'CHF', 'CAD', 'USD', 'GBP'];

interface Member {
    id: string;
    circle_id: string;
    user_id: string;
    role: CircleRole;
    color: string;
    created_at: string;
    name: string;
    email: string;
    avatar_url: string | null;
}

interface CircleDetail {
    circle: { id: string; name: string; currency: string };
    recipient: { first_name: string; last_name: string | null } | null;
    members: Member[];
    my_role: CircleRole;
}

interface Invite {
    id: string;
    token: string;
    invitee_email: string | null;
    role: CircleRole;
    status: string;
    expires_at: string;
    created_at: string;
}

interface CaregiverLink {
    id: string;
    token: string;
    display_name: string;
    role_label: string | null;
    revoked: boolean;
    expires_at: string | null;
    last_used_at: string | null;
    created_at: string;
    status: 'active' | 'expired' | 'revoked';
}

const roleBadgeVariant = (role: CircleRole): 'primary' | 'default' | 'secondary' => {
    if (role === 'admin') return 'primary';
    if (role === 'viewer') return 'secondary';
    return 'default';
};

// ── Équité de la charge ──────────────────────────────────────────────────────

interface EquityMember {
    member_id: string;
    user_id: string;
    role: CircleRole;
    color: string;
    name: string;
    visits: number;
    tasks: number;
    events: number;
    total: number;
    percent: number;
}

interface EquityTotals {
    visits: number;
    tasks: number;
    events: number;
    total: number;
}

interface EquityData {
    months: number;
    members: EquityMember[];
    totals: EquityTotals;
    previous_members: EquityMember[];
    previous_totals: EquityTotals;
}

type EquityPeriod = '1' | '3' | '12';
const EQUITY_PERIODS: EquityPeriod[] = ['1', '3', '12'];

/**
 * Répartition de la charge entre les membres du cercle: qui porte quoi
 * (visites au journal, tâches faites, présences aux rendez-vous), pour
 * objectiver la charge et prévenir l'épuisement de l'aidant principal.
 */
const EquitySection: React.FC<{ circleId: string }> = ({ circleId }) => {
    const { t } = useTranslation(['circle', 'common']);
    const [months, setMonths] = useState<EquityPeriod>('1');
    const [data, setData] = useState<EquityData | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const res = await api.get<{ success: boolean; data: EquityData }>(
                    `/api/insights/equity?months=${months}`
                );
                if (!cancelled && res.success) {
                    setData(res.data);
                    setFailed(false);
                }
            } catch (error) {
                console.error('Equity load error:', error);
                if (!cancelled) setFailed(true);
            }
        };
        void load();
        return () => { cancelled = true; };
    }, [circleId, months]);

    const members = data ? [...data.members].sort((a, b) => b.total - a.total) : [];
    const previousById = new Map((data?.previous_members ?? []).map((m) => [m.member_id, m]));
    const hasPrevious = (data?.previous_totals.total ?? 0) > 0;

    // Phrase de synthèse sur les visites: « Marie a assuré 78 % des visites ce mois-ci »
    const totalVisits = data?.totals.visits ?? 0;
    const topVisitor = totalVisits > 0
        ? members.reduce((best, m) => (m.visits > best.visits ? m : best), members[0])
        : null;

    return (
        <Card hover={false}>
            <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <CardTitle className="font-serif">{t('circle:equity.title')}</CardTitle>
                        <p className="mt-1 text-caption text-muted-foreground">
                            {t('circle:equity.subtitle')}
                        </p>
                    </div>
                    <Select
                        value={months}
                        onValueChange={(value) => setMonths(value as EquityPeriod)}
                        options={EQUITY_PERIODS.map((p) => ({
                            value: p,
                            label: t(`circle:equity.periods.${p}`),
                        }))}
                        placeholder={t('circle:equity.periodLabel')}
                        className="h-11 w-44 md:h-10"
                    />
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {failed ? (
                    <p className="text-caption text-muted-foreground">{t('circle:equity.error')}</p>
                ) : !data ? (
                    <p className="text-caption text-muted-foreground">{t('common:states.loading')}</p>
                ) : data.totals.total === 0 ? (
                    <p className="rounded-input border border-dashed border-border-strong p-4 text-center text-caption text-muted-foreground">
                        {t('circle:equity.empty')}
                    </p>
                ) : (
                    <>
                        {topVisitor && topVisitor.visits > 0 && (
                            <p className="text-body text-foreground">
                                {t('circle:equity.summary', {
                                    name: topVisitor.name,
                                    percent: Math.round((topVisitor.visits / totalVisits) * 100),
                                    period: t(`circle:equity.summaryPeriods.${months}`),
                                })}
                            </p>
                        )}
                        <ul className="space-y-3">
                            {members.map((member) => {
                                const previous = previousById.get(member.member_id);
                                const detail = [
                                    t('circle:equity.visits', { count: member.visits }),
                                    t('circle:equity.tasks', { count: member.tasks }),
                                    t('circle:equity.presences', { count: member.events }),
                                ].join(', ');
                                return (
                                    <li key={member.member_id}>
                                        <div className="flex items-baseline justify-between gap-2">
                                            <span className="truncate text-caption font-medium text-foreground">
                                                {member.name}
                                            </span>
                                            <span className="shrink-0 text-caption font-semibold text-foreground">
                                                {member.percent} %
                                            </span>
                                        </div>
                                        <div
                                            className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-surface-2"
                                            role="img"
                                            aria-label={`${member.name}: ${member.percent} %`}
                                        >
                                            <div
                                                className="h-full rounded-full transition-all"
                                                style={{
                                                    width: `${member.percent}%`,
                                                    backgroundColor: member.color || '#3e6b54',
                                                }}
                                            />
                                        </div>
                                        <p className="mt-1 text-micro text-muted-foreground">
                                            {detail}
                                            {hasPrevious && (
                                                <span>
                                                    {' · '}
                                                    {t('circle:equity.previousPercent', {
                                                        percent: previous?.percent ?? 0,
                                                    })}
                                                </span>
                                            )}
                                        </p>
                                    </li>
                                );
                            })}
                        </ul>
                        {!hasPrevious && (
                            <p className="text-micro text-muted-foreground">
                                {t('circle:equity.previousNone')}
                            </p>
                        )}
                    </>
                )}
                <p className="rounded-input bg-primary-soft px-3 py-2 text-micro text-foreground">
                    {t('circle:equity.hint')}
                </p>
            </CardContent>
        </Card>
    );
};

const MemberAvatar: React.FC<{ member: Member }> = ({ member }) =>
    member.avatar_url ? (
        <img
            src={member.avatar_url}
            alt=""
            className="h-10 w-10 shrink-0 rounded-full object-cover"
        />
    ) : (
        <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-caption font-semibold text-white"
            style={{ backgroundColor: member.color || '#3e6b54' }}
            aria-hidden="true"
        >
            {(member.name || '?').charAt(0).toUpperCase()}
        </div>
    );

const Circle: React.FC = () => {
    const { t } = useTranslation(['circle', 'common']);
    const navigate = useNavigate();
    const { user } = useAuth();
    const { activeCircle, isAdmin, canWriteContent, refreshCircles } = useCircle();
    const { showToast } = useToast();

    const [detail, setDetail] = useState<CircleDetail | null>(null);
    const [invites, setInvites] = useState<Invite[]>([]);
    const [links, setLinks] = useState<CaregiverLink[]>([]);
    const [loading, setLoading] = useState(true);

    // Invite creation dialog
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteRole, setInviteRole] = useState<CircleRole>('family');
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteDays, setInviteDays] = useState('7');
    const [inviteSaving, setInviteSaving] = useState(false);

    // Caregiver link creation dialog (two steps: form, then link to share)
    const [linkOpen, setLinkOpen] = useState(false);
    const [linkName, setLinkName] = useState('');
    const [linkRoleLabel, setLinkRoleLabel] = useState('');
    const [linkDays, setLinkDays] = useState('');
    const [linkSaving, setLinkSaving] = useState(false);
    const [createdLinkUrl, setCreatedLinkUrl] = useState<string | null>(null);

    // Confirmations
    const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);
    const [leaveOpen, setLeaveOpen] = useState(false);
    const [linkToDelete, setLinkToDelete] = useState<CaregiverLink | null>(null);
    const [deleteCircleOpen, setDeleteCircleOpen] = useState(false);
    const [deleteCircleInput, setDeleteCircleInput] = useState('');
    const [actionBusy, setActionBusy] = useState(false);

    // Circle settings (admin)
    const [settingsName, setSettingsName] = useState('');
    const [settingsCurrency, setSettingsCurrency] = useState('EUR');
    const [settingsSaving, setSettingsSaving] = useState(false);

    const circleId = activeCircle?.id ?? null;

    const loadAll = useCallback(async () => {
        if (!circleId) {
            setLoading(false);
            return;
        }
        try {
            const requests: [
                Promise<{ success: boolean; data: CircleDetail }>,
                Promise<{ success: boolean; data: Invite[] } | null>,
                Promise<{ success: boolean; data: CaregiverLink[] } | null>,
            ] = [
                api.get<{ success: boolean; data: CircleDetail }>(`/api/circles/${circleId}`),
                isAdmin ? api.get<{ success: boolean; data: Invite[] }>('/api/invites') : Promise.resolve(null),
                canWriteContent ? api.get<{ success: boolean; data: CaregiverLink[] }>('/api/caregiver-links') : Promise.resolve(null),
            ];
            const [detailRes, invitesRes, linksRes] = await Promise.all(requests);
            if (detailRes.success) {
                setDetail(detailRes.data);
                setSettingsName(detailRes.data.circle.name);
                setSettingsCurrency(detailRes.data.circle.currency || 'EUR');
            }
            setInvites(invitesRes?.success ? invitesRes.data : []);
            setLinks(linksRes?.success ? linksRes.data : []);
        } catch (error) {
            console.error('Circle load error:', error);
            showToast({ title: t('circle:errors.load') });
        } finally {
            setLoading(false);
        }
    }, [circleId, isAdmin, canWriteContent, showToast, t]);

    useEffect(() => {
        setLoading(true);
        void loadAll();
    }, [loadAll]);

    useWebSocketUpdates('circle', () => { void loadAll(); });

    const onError = (error: unknown) => {
        const message = error instanceof Error ? error.message : t('circle:errors.action');
        showToast({ title: t('common:states.error'), description: message });
    };

    const copyToClipboard = async (text: string, successTitle: string) => {
        try {
            await navigator.clipboard.writeText(text);
            showToast({ title: successTitle, description: text });
        } catch (error) {
            onError(error);
        }
    };

    // ── Members ──────────────────────────────────────────────────────────────

    const myMember = detail?.members.find((m) => m.user_id === user?.id) ?? null;

    const changeMemberRole = async (member: Member, role: string) => {
        if (!circleId || role === member.role) return;
        try {
            await api.put(`/api/circles/${circleId}/members/${member.id}`, { role });
            showToast({ title: t('circle:members.roleUpdated') });
            await loadAll();
            await refreshCircles();
        } catch (error) {
            onError(error);
        }
    };

    const removeMember = async () => {
        if (!circleId || !memberToRemove) return;
        setActionBusy(true);
        try {
            await api.delete(`/api/circles/${circleId}/members/${memberToRemove.id}`);
            setMemberToRemove(null);
            showToast({ title: t('circle:members.removed') });
            await loadAll();
        } catch (error) {
            onError(error);
        } finally {
            setActionBusy(false);
        }
    };

    const leaveCircle = async () => {
        if (!circleId || !myMember) return;
        setActionBusy(true);
        try {
            await api.delete(`/api/circles/${circleId}/members/${myMember.id}`);
            setLeaveOpen(false);
            showToast({ title: t('circle:members.left') });
            await refreshCircles();
            navigate('/');
        } catch (error) {
            onError(error);
        } finally {
            setActionBusy(false);
        }
    };

    // ── Invitations ──────────────────────────────────────────────────────────

    const createInvite = async (e: React.FormEvent) => {
        e.preventDefault();
        setInviteSaving(true);
        try {
            await api.post('/api/invites', {
                role: inviteRole,
                invitee_email: inviteEmail.trim() || undefined,
                expires_in_days: Number(inviteDays),
            });
            setInviteOpen(false);
            setInviteEmail('');
            setInviteRole('family');
            setInviteDays('7');
            showToast({ title: t('circle:invites.created') });
            await loadAll();
        } catch (error) {
            onError(error);
        } finally {
            setInviteSaving(false);
        }
    };

    const revokeInvite = async (invite: Invite) => {
        try {
            await api.delete(`/api/invites/${invite.id}`);
            showToast({ title: t('circle:invites.revoked') });
            await loadAll();
        } catch (error) {
            onError(error);
        }
    };

    // ── Caregiver links ──────────────────────────────────────────────────────

    const createLink = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!linkName.trim()) return;
        setLinkSaving(true);
        try {
            const res = await api.post<{ success: boolean; data: CaregiverLink & { url: string } }>(
                '/api/caregiver-links',
                {
                    display_name: linkName.trim(),
                    role_label: linkRoleLabel.trim() || undefined,
                    expires_in_days: linkDays ? Number(linkDays) : undefined,
                }
            );
            if (res.success) {
                setCreatedLinkUrl(window.location.origin + res.data.url);
                showToast({ title: t('circle:links.created') });
            }
            await loadAll();
        } catch (error) {
            onError(error);
        } finally {
            setLinkSaving(false);
        }
    };

    const closeLinkDialog = () => {
        setLinkOpen(false);
        setCreatedLinkUrl(null);
        setLinkName('');
        setLinkRoleLabel('');
        setLinkDays('');
    };

    const toggleLinkRevoked = async (link: CaregiverLink) => {
        try {
            await api.put(`/api/caregiver-links/${link.id}`, { revoked: !link.revoked });
            showToast({ title: link.revoked ? t('circle:links.reactivated') : t('circle:links.revokedToast') });
            await loadAll();
        } catch (error) {
            onError(error);
        }
    };

    const deleteLink = async () => {
        if (!linkToDelete) return;
        setActionBusy(true);
        try {
            await api.delete(`/api/caregiver-links/${linkToDelete.id}`);
            setLinkToDelete(null);
            showToast({ title: t('circle:links.deleted') });
            await loadAll();
        } catch (error) {
            onError(error);
        } finally {
            setActionBusy(false);
        }
    };

    // ── Circle settings ──────────────────────────────────────────────────────

    const saveSettings = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!circleId || !settingsName.trim()) return;
        setSettingsSaving(true);
        try {
            await api.put(`/api/circles/${circleId}`, {
                name: settingsName.trim(),
                currency: settingsCurrency,
            });
            showToast({ title: t('circle:settings.saved') });
            await refreshCircles();
            await loadAll();
        } catch (error) {
            onError(error);
        } finally {
            setSettingsSaving(false);
        }
    };

    const recipientFirstName = detail?.recipient?.first_name ?? '';
    // Double confirmation: type the recipient's first name (fallback: circle name).
    const deleteTargetName = recipientFirstName.trim() || (detail?.circle.name ?? '').trim();
    const deleteConfirmed =
        deleteTargetName !== ''
        && deleteCircleInput.trim().toLowerCase() === deleteTargetName.toLowerCase();

    const deleteCircle = async () => {
        if (!circleId || !deleteConfirmed) return;
        setActionBusy(true);
        try {
            await api.delete(`/api/circles/${circleId}`);
            setDeleteCircleOpen(false);
            showToast({ title: t('circle:settings.deleted') });
            await refreshCircles();
            navigate('/');
        } catch (error) {
            onError(error);
        } finally {
            setActionBusy(false);
        }
    };

    // ── Render ───────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="flex min-h-[50vh] items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner-brand" />
                    <p className="font-medium text-muted-foreground">{t('common:states.loading')}</p>
                </div>
            </div>
        );
    }

    if (!activeCircle || !detail) {
        return (
            <div className="rounded-card border border-dashed border-border-strong p-8 text-center">
                <p className="text-body text-muted-foreground">{t('circle:noCircle')}</p>
            </div>
        );
    }

    const roleOptions = ROLES.map((role) => ({ value: role, label: t(`circle:roles.${role}`) }));

    return (
        <div className="mx-auto max-w-3xl space-y-8">
            <div>
                <h1 className="font-serif text-display text-foreground">{t('circle:title')}</h1>
                <p className="mt-1 text-caption text-muted-foreground">
                    {recipientFirstName
                        ? t('circle:subtitle', { name: recipientFirstName })
                        : t('circle:subtitleNoName')}
                </p>
            </div>

            {/* Membres */}
            <Card hover={false}>
                <CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
                    <CardTitle className="font-serif">{t('circle:members.title')}</CardTitle>
                    <span className="text-caption text-muted-foreground">
                        {t('circle:members.count', { count: detail.members.length })}
                    </span>
                </CardHeader>
                <CardContent className="space-y-0 divide-y divide-border">
                    {detail.members.map((member) => {
                        const isSelf = member.user_id === user?.id;
                        return (
                            <div
                                key={member.id}
                                className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
                            >
                                <MemberAvatar member={member} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-body font-medium text-foreground">
                                        {member.name}
                                        {isSelf && (
                                            <span className="ml-1.5 text-caption font-normal text-muted-foreground">
                                                ({t('circle:members.you')})
                                            </span>
                                        )}
                                    </p>
                                    <p className="truncate text-caption text-muted-foreground">{member.email}</p>
                                </div>
                                {isAdmin ? (
                                    <div className="flex items-center gap-1">
                                        <Select
                                            value={member.role}
                                            onValueChange={(role) => void changeMemberRole(member, role)}
                                            options={roleOptions}
                                            className="h-11 w-44 md:h-10"
                                        />
                                        {!isSelf && (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-11 w-11 text-muted-foreground hover:text-danger md:h-10 md:w-10"
                                                aria-label={`${t('circle:members.remove')}: ${member.name}`}
                                                title={t('circle:members.remove')}
                                                onClick={() => setMemberToRemove(member)}
                                            >
                                                <UserMinus className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </div>
                                ) : (
                                    <Badge variant={roleBadgeVariant(member.role)}>
                                        {t(`circle:roles.${member.role}`)}
                                    </Badge>
                                )}
                            </div>
                        );
                    })}

                    {myMember && (
                        <div className="pt-4">
                            <Button variant="ghost" size="sm" onClick={() => setLeaveOpen(true)}>
                                <LogOut className="mr-2 h-4 w-4" />
                                {t('circle:members.leave')}
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Equite de la charge: qui porte quoi sur la periode (admin et family) */}
            {canWriteContent && <EquitySection circleId={activeCircle.id} />}

            {/* Intervenants sans compte: liens magiques, le differenciateur cle */}
            {canWriteContent && (
                <Card hover={false} className="border-primary/30">
                    <CardHeader>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex items-start gap-3">
                                <div className="shrink-0 rounded-input bg-primary-soft p-2">
                                    <Link2 className="h-5 w-5 text-primary" />
                                </div>
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <CardTitle className="font-serif">{t('circle:links.title')}</CardTitle>
                                        <Badge variant="primary">{t('circle:links.tag')}</Badge>
                                    </div>
                                    <p className="mt-1 text-caption text-muted-foreground">
                                        {t('circle:links.subtitle')}
                                    </p>
                                </div>
                            </div>
                            <Button size="sm" onClick={() => setLinkOpen(true)}>
                                <Plus className="mr-2 h-4 w-4" />
                                {t('circle:links.create')}
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {links.length === 0 ? (
                            <p className="rounded-input border border-dashed border-border-strong p-4 text-center text-caption text-muted-foreground">
                                {t('circle:links.empty')}
                            </p>
                        ) : (
                            <ul className="divide-y divide-border">
                                {links.map((link) => (
                                    <li key={link.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <p className="truncate text-body font-medium text-foreground">
                                                    {link.display_name}
                                                </p>
                                                <Badge
                                                    variant={
                                                        link.status === 'active' ? 'success'
                                                            : link.status === 'expired' ? 'warning' : 'danger'
                                                    }
                                                >
                                                    {t(`circle:links.status.${link.status}`)}
                                                </Badge>
                                            </div>
                                            <p className="mt-0.5 text-caption text-muted-foreground">
                                                {link.role_label ? `${link.role_label} · ` : ''}
                                                {link.last_used_at
                                                    ? t('circle:links.lastUsed', { date: formatDate(link.last_used_at) })
                                                    : t('circle:links.neverUsed')}
                                                {link.expires_at
                                                    ? ` · ${t('circle:links.expiresOn', { date: formatDate(link.expires_at) })}`
                                                    : ''}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            {link.status === 'active' && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-11 w-11 md:h-10 md:w-10"
                                                    aria-label={`${t('circle:links.copy')}: ${link.display_name}`}
                                                    title={t('circle:links.copy')}
                                                    onClick={() =>
                                                        void copyToClipboard(
                                                            `${window.location.origin}/care/${link.token}`,
                                                            t('circle:links.copied')
                                                        )
                                                    }
                                                >
                                                    <Copy className="h-4 w-4" />
                                                </Button>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-11 w-11 md:h-10 md:w-10"
                                                aria-label={`${link.revoked ? t('circle:links.reactivate') : t('circle:links.revoke')}: ${link.display_name}`}
                                                title={link.revoked ? t('circle:links.reactivate') : t('circle:links.revoke')}
                                                onClick={() => void toggleLinkRevoked(link)}
                                            >
                                                {link.revoked
                                                    ? <RotateCcw className="h-4 w-4" />
                                                    : <Ban className="h-4 w-4" />}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-11 w-11 text-muted-foreground hover:text-danger md:h-10 md:w-10"
                                                aria-label={`${t('circle:links.delete')}: ${link.display_name}`}
                                                title={t('circle:links.delete')}
                                                onClick={() => setLinkToDelete(link)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <p className="mt-4 text-micro text-muted-foreground">{t('circle:links.explain')}</p>
                    </CardContent>
                </Card>
            )}

            {/* Invitations */}
            {isAdmin && (
                <Card hover={false}>
                    <CardHeader>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <CardTitle className="font-serif">{t('circle:invites.title')}</CardTitle>
                                <p className="mt-1 text-caption text-muted-foreground">
                                    {t('circle:invites.subtitle')}
                                </p>
                            </div>
                            <Button variant="secondary" size="sm" onClick={() => setInviteOpen(true)}>
                                <Mail className="mr-2 h-4 w-4" />
                                {t('circle:invites.create')}
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {invites.length === 0 ? (
                            <p className="rounded-input border border-dashed border-border-strong p-4 text-center text-caption text-muted-foreground">
                                {t('circle:invites.empty')}
                            </p>
                        ) : (
                            <ul className="divide-y divide-border">
                                {invites.map((invite) => (
                                    <li key={invite.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Badge variant={roleBadgeVariant(invite.role)}>
                                                    {t(`circle:roles.${invite.role}`)}
                                                </Badge>
                                                <span className="truncate text-caption text-foreground">
                                                    {invite.invitee_email || t('circle:invites.anyEmail')}
                                                </span>
                                            </div>
                                            <p className="mt-0.5 text-micro text-muted-foreground">
                                                {t('circle:invites.expiresOn', { date: formatDate(invite.expires_at) })}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-11 w-11 md:h-10 md:w-10"
                                                aria-label={t('circle:invites.copy')}
                                                title={t('circle:invites.copy')}
                                                onClick={() =>
                                                    void copyToClipboard(
                                                        `${window.location.origin}/join?token=${invite.token}`,
                                                        t('circle:invites.copied')
                                                    )
                                                }
                                            >
                                                <Copy className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-11 w-11 text-muted-foreground hover:text-danger md:h-10 md:w-10"
                                                aria-label={t('circle:invites.revoke')}
                                                title={t('circle:invites.revoke')}
                                                onClick={() => void revokeInvite(invite)}
                                            >
                                                <Ban className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* Reglages du cercle */}
            {isAdmin && (
                <Card hover={false}>
                    <CardHeader>
                        <CardTitle className="font-serif">{t('circle:settings.title')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <form onSubmit={(e) => void saveSettings(e)} className="space-y-4">
                            <Input
                                label={t('circle:settings.name')}
                                value={settingsName}
                                onChange={(e) => setSettingsName(e.target.value)}
                                required
                            />
                            <div>
                                <label className="mb-1.5 block text-caption font-medium text-foreground">
                                    {t('circle:settings.currency')}
                                </label>
                                <Select
                                    value={settingsCurrency}
                                    onValueChange={setSettingsCurrency}
                                    options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                                    className="h-11 w-40 md:h-10"
                                />
                            </div>
                            <Button type="submit" variant="secondary" size="sm" disabled={settingsSaving || !settingsName.trim()}>
                                {settingsSaving ? t('common:states.saving') : t('circle:settings.save')}
                            </Button>
                        </form>

                        <div className="border-t border-border pt-5">
                            <h3 className="text-body font-medium text-danger">{t('circle:settings.dangerTitle')}</h3>
                            <p className="mt-1 text-caption text-muted-foreground">{t('circle:settings.dangerHint')}</p>
                            <Button
                                variant="destructive"
                                size="sm"
                                className="mt-3"
                                onClick={() => {
                                    setDeleteCircleInput('');
                                    setDeleteCircleOpen(true);
                                }}
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t('circle:settings.deleteButton')}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Dialog: nouvelle invitation */}
            <Dialog
                open={inviteOpen}
                onOpenChange={setInviteOpen}
                title={t('circle:invites.dialogTitle')}
                description={t('circle:invites.dialogDescription')}
            >
                <form onSubmit={(e) => void createInvite(e)} className="space-y-4">
                    <div>
                        <label className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('circle:invites.role')}
                        </label>
                        <Select
                            value={inviteRole}
                            onValueChange={(value) => setInviteRole(value as CircleRole)}
                            options={roleOptions}
                            className="h-11 w-full md:h-10"
                        />
                        <p className="mt-1.5 text-micro text-muted-foreground">
                            {t(`circle:roleHints.${inviteRole}`)}
                        </p>
                    </div>
                    <div>
                        <Input
                            type="email"
                            label={t('circle:invites.email')}
                            value={inviteEmail}
                            onChange={(e) => setInviteEmail(e.target.value)}
                            placeholder="prenom.nom@exemple.fr"
                        />
                        <p className="mt-1.5 text-micro text-muted-foreground">{t('circle:invites.emailHint')}</p>
                    </div>
                    <div>
                        <label className="mb-1.5 block text-caption font-medium text-foreground">
                            {t('circle:invites.duration')}
                        </label>
                        <Select
                            value={inviteDays}
                            onValueChange={setInviteDays}
                            options={['7', '14', '30'].map((d) => ({
                                value: d,
                                label: t(`circle:invites.days_${d}`),
                            }))}
                            className="h-11 w-40 md:h-10"
                        />
                    </div>
                    <div className="flex justify-end gap-2 pt-2">
                        <Button type="button" variant="ghost" onClick={() => setInviteOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button type="submit" disabled={inviteSaving}>
                            {inviteSaving ? t('common:states.saving') : t('circle:invites.submit')}
                        </Button>
                    </div>
                </form>
            </Dialog>

            {/* Dialog: nouveau lien intervenant */}
            <Dialog
                open={linkOpen}
                onOpenChange={(open) => { if (!open) closeLinkDialog(); }}
                title={createdLinkUrl ? t('circle:links.shareTitle') : t('circle:links.dialogTitle')}
                description={t('circle:links.explain')}
            >
                {createdLinkUrl ? (
                    <div className="space-y-4">
                        <div className="flex items-center gap-2 rounded-input border border-border bg-surface-2 px-3 py-2.5">
                            <code className="min-w-0 flex-1 break-all text-caption text-foreground">
                                {createdLinkUrl}
                            </code>
                            <Button
                                variant="secondary"
                                size="sm"
                                className="shrink-0"
                                onClick={() => void copyToClipboard(createdLinkUrl, t('circle:links.copied'))}
                            >
                                <Copy className="mr-2 h-4 w-4" />
                                {t('circle:links.copy')}
                            </Button>
                        </div>
                        <p className="text-micro text-muted-foreground">{t('circle:links.shareHint')}</p>
                        <div className="flex justify-end">
                            <Button onClick={closeLinkDialog}>{t('circle:links.done')}</Button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={(e) => void createLink(e)} className="space-y-4">
                        <Input
                            label={t('circle:links.displayName')}
                            value={linkName}
                            onChange={(e) => setLinkName(e.target.value)}
                            placeholder={t('circle:links.displayNamePlaceholder')}
                            maxLength={100}
                            required
                        />
                        <Input
                            label={t('circle:links.roleLabel')}
                            value={linkRoleLabel}
                            onChange={(e) => setLinkRoleLabel(e.target.value)}
                            placeholder={t('circle:links.roleLabelPlaceholder')}
                            maxLength={100}
                        />
                        <div>
                            <label className="mb-1.5 block text-caption font-medium text-foreground">
                                {t('circle:links.expiration')}
                            </label>
                            <Select
                                value={linkDays}
                                onValueChange={setLinkDays}
                                options={[
                                    { value: '', label: t('circle:links.noExpiration') },
                                    ...['7', '30', '90', '180', '365'].map((d) => ({
                                        value: d,
                                        label: t(`circle:links.expDays_${d}`),
                                    })),
                                ]}
                                className="h-11 w-full md:h-10"
                            />
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                            <Button type="button" variant="ghost" onClick={closeLinkDialog}>
                                {t('common:actions.cancel')}
                            </Button>
                            <Button type="submit" disabled={linkSaving || !linkName.trim()}>
                                {linkSaving ? t('common:states.saving') : t('circle:links.submit')}
                            </Button>
                        </div>
                    </form>
                )}
            </Dialog>

            {/* Dialog: retirer un membre */}
            <Dialog
                open={memberToRemove !== null}
                onOpenChange={(open) => { if (!open) setMemberToRemove(null); }}
                title={t('circle:members.removeTitle')}
            >
                <p className="text-caption text-muted-foreground">
                    {t('circle:members.removeConfirm', { name: memberToRemove?.name ?? '' })}
                </p>
                <div className="mt-5 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setMemberToRemove(null)}>
                        {t('common:actions.cancel')}
                    </Button>
                    <Button variant="destructive" disabled={actionBusy} onClick={() => void removeMember()}>
                        {t('circle:members.remove')}
                    </Button>
                </div>
            </Dialog>

            {/* Dialog: quitter le cercle */}
            <Dialog open={leaveOpen} onOpenChange={setLeaveOpen} title={t('circle:members.leaveTitle')}>
                <p className="text-caption text-muted-foreground">{t('circle:members.leaveConfirm')}</p>
                <div className="mt-5 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setLeaveOpen(false)}>
                        {t('common:actions.cancel')}
                    </Button>
                    <Button variant="destructive" disabled={actionBusy} onClick={() => void leaveCircle()}>
                        {t('circle:members.leave')}
                    </Button>
                </div>
            </Dialog>

            {/* Dialog: supprimer un lien intervenant */}
            <Dialog
                open={linkToDelete !== null}
                onOpenChange={(open) => { if (!open) setLinkToDelete(null); }}
                title={t('circle:links.deleteTitle')}
            >
                <p className="text-caption text-muted-foreground">
                    {t('circle:links.deleteConfirm', { name: linkToDelete?.display_name ?? '' })}
                </p>
                <div className="mt-5 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setLinkToDelete(null)}>
                        {t('common:actions.cancel')}
                    </Button>
                    <Button variant="destructive" disabled={actionBusy} onClick={() => void deleteLink()}>
                        {t('circle:links.delete')}
                    </Button>
                </div>
            </Dialog>

            {/* Dialog: supprimer le cercle (double confirmation) */}
            <Dialog
                open={deleteCircleOpen}
                onOpenChange={setDeleteCircleOpen}
                title={t('circle:settings.deleteDialogTitle')}
                description={t('circle:settings.dangerHint')}
            >
                <div className="space-y-4">
                    <Input
                        label={t('circle:settings.deletePrompt', { name: deleteTargetName })}
                        value={deleteCircleInput}
                        onChange={(e) => setDeleteCircleInput(e.target.value)}
                        autoComplete="off"
                    />
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => setDeleteCircleOpen(false)}>
                            {t('common:actions.cancel')}
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={actionBusy || !deleteConfirmed}
                            onClick={() => void deleteCircle()}
                        >
                            {t('circle:settings.deleteConfirm')}
                        </Button>
                    </div>
                </div>
            </Dialog>
        </div>
    );
};

export default Circle;
