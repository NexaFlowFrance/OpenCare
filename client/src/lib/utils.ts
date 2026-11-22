import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { parseISO } from 'date-fns';
import { intlLocale } from '../i18n/format';
import { formatClockIn } from './clock';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string): string {
    // parseISO reads a bare "YYYY-MM-DD" as local midnight; new Date() reads it as UTC (a day early west of UTC).
    const d = typeof date === 'string' ? parseISO(date) : date;
    return d.toLocaleDateString(intlLocale(), {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

export function formatTime(date: Date | string): string {
    return formatClockIn(intlLocale(), date);
}

export function formatCurrency(amount: number, currency: string = 'EUR'): string {
    return new Intl.NumberFormat(intlLocale(), {
        style: 'currency',
        currency: currency.toUpperCase()
    }).format(amount);
}
