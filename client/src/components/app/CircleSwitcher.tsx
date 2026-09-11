import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus, Check, Link2 } from 'lucide-react';
import { useCircle } from '../../contexts/CircleContext';
import { cn } from '../../lib/utils';

/**
 * Sélecteur de cercle (multi-proches). Affiché en tête de la barre latérale:
 * photo + prénom du proche, menu pour changer de cercle ou en créer un.
 */
export const CircleSwitcher: React.FC<{ onNavigate?: () => void }> = ({ onNavigate }) => {
    const { circles, activeCircle, selectCircle } = useCircle();
    const { t } = useTranslation('nav');
    const navigate = useNavigate();
    const [open, setOpen] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const onClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, []);

    if (!activeCircle) return null;

    const recipientName = activeCircle.recipient_first_name || activeCircle.name;

    // Partenaires du foyer (couple): autres cercles partageant le household_id.
    const partnersOf = (householdId: string | null, selfId: string): string[] =>
        householdId
            ? circles
                .filter((c) => c.household_id === householdId && c.id !== selfId)
                .map((c) => c.recipient_first_name || c.name)
            : [];

    const Avatar: React.FC<{ photo: string | null; name: string; size?: string }> = ({ photo, name, size = 'h-9 w-9' }) => (
        photo ? (
            <img src={photo} alt={name} className={cn(size, 'shrink-0 rounded-full object-cover')} />
        ) : (
            <div className={cn(size, 'flex shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary font-semibold')}>
                {name.charAt(0).toUpperCase()}
            </div>
        )
    );

    return (
        <div ref={containerRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    'flex w-full items-center gap-3 rounded-card border border-border bg-surface-2/60 px-3 py-2.5 text-left',
                    'transition-colors duration-fast ease-soft hover:border-border-strong'
                )}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <Avatar photo={activeCircle.recipient_photo_url} name={recipientName} />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-caption font-semibold text-foreground">{recipientName}</p>
                    <p className="truncate text-micro text-muted-foreground">{t(`roles.${activeCircle.role}`)}</p>
                </div>
                <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="absolute inset-x-0 top-full z-50 mt-2 rounded-card border border-border bg-popover p-1.5 shadow-surface-hover">
                    {circles.map((circle) => {
                        const name = circle.recipient_first_name || circle.name;
                        const isActive = circle.id === activeCircle.id;
                        const partners = partnersOf(circle.household_id, circle.id);
                        return (
                            <button
                                key={circle.id}
                                type="button"
                                onClick={() => {
                                    selectCircle(circle.id);
                                    setOpen(false);
                                    onNavigate?.();
                                }}
                                className={cn(
                                    'flex w-full items-center gap-2.5 rounded-input px-2.5 py-2 text-left text-caption',
                                    isActive ? 'bg-primary-soft text-primary' : 'text-foreground hover:bg-surface-2'
                                )}
                            >
                                <Avatar photo={circle.recipient_photo_url} name={name} size="h-7 w-7" />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate font-medium">{name}</span>
                                    {partners.length > 0 && (
                                        <span className="flex items-center gap-1 truncate text-micro text-muted-foreground">
                                            <Link2 className="h-3 w-3 shrink-0" />
                                            {t('circle.householdWith', { names: partners.join(', ') })}
                                        </span>
                                    )}
                                </span>
                                {isActive && <Check className="h-4 w-4 shrink-0" />}
                            </button>
                        );
                    })}
                    <div className="my-1 border-t border-border" />
                    <button
                        type="button"
                        onClick={() => {
                            setOpen(false);
                            onNavigate?.();
                            navigate('/onboarding');
                        }}
                        className="flex w-full items-center gap-2.5 rounded-input px-2.5 py-2 text-left text-caption text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                    >
                        <div className="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-border-strong">
                            <Plus className="h-4 w-4" />
                        </div>
                        <span className="font-medium">{t('circle.create')}</span>
                    </button>
                </div>
            )}
        </div>
    );
};
