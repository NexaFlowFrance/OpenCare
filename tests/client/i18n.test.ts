import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Les traductions sont le seul endroit du projet ou une erreur passe la
 * relecture sans bruit : une cle oubliee affiche `nav.items.today` a l'ecran,
 * un placeholder perdu affiche "Bonjour {{name}}". Ce fichier garde la
 * coherence des langues et remplace les verifications faites a la main.
 */

const LOCALES = path.resolve(__dirname, '../../client/src/i18n/locales');
const REFERENCE = 'fr';
const EM_DASH = String.fromCharCode(0x2014);

const read = (lng: string, ns: string) =>
    JSON.parse(fs.readFileSync(path.join(LOCALES, lng, ns), 'utf8')) as Record<string, unknown>;

const flatten = (value: unknown, prefix = ''): string[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        flatten(child, prefix ? `${prefix}.${key}` : key)
    );
};

const valueAt = (obj: unknown, keyPath: string): unknown =>
    keyPath.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), obj);

const placeholders = (value: unknown): string[] => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort();
};

const languages = fs.readdirSync(LOCALES).filter((d) => fs.statSync(path.join(LOCALES, d)).isDirectory());
const namespaces = fs.readdirSync(path.join(LOCALES, REFERENCE)).filter((f) => f.endsWith('.json'));

describe('langues disponibles', () => {
    it('trouve le francais, l anglais et au moins une autre langue', () => {
        expect(languages).toContain('fr');
        expect(languages).toContain('en');
        expect(languages.length).toBeGreaterThanOrEqual(3);
    });

    it('a des espaces de noms a verifier', () => {
        expect(namespaces.length).toBeGreaterThan(20);
    });
});

describe('francais et anglais', () => {
    // Les deux langues de reference sont completes : l'anglais est le repli de
    // toutes les autres, une cle qui y manque n'a plus aucun filet.
    it.each(namespaces)('%s a exactement les memes cles en fr et en en', (ns) => {
        const fr = flatten(read('fr', ns)).sort();
        const en = flatten(read('en', ns)).sort();
        expect(en.filter((k) => !fr.includes(k))).toEqual([]);
        expect(fr.filter((k) => !en.includes(k))).toEqual([]);
    });

    it.each(namespaces)('%s garde les memes variables dans les deux langues', (ns) => {
        const fr = read('fr', ns);
        const en = read('en', ns);
        const differences = flatten(fr)
            .map((key) => ({ key, fr: placeholders(valueAt(fr, key)), en: placeholders(valueAt(en, key)) }))
            .filter((row) => row.fr.join(',') !== row.en.join(','));
        expect(differences).toEqual([]);
    });
});

describe('toutes les langues', () => {
    const others = languages.filter((l) => l !== 'fr' && l !== 'en');

    it.each(languages)('%s n utilise jamais le tiret long', (lng) => {
        const guilty = fs.readdirSync(path.join(LOCALES, lng))
            .filter((f) => f.endsWith('.json'))
            .filter((f) => fs.readFileSync(path.join(LOCALES, lng, f), 'utf8').includes(EM_DASH));
        expect(guilty).toEqual([]);
    });

    it.each(languages)('%s ecrit des JSON valides, sans BOM', (lng) => {
        for (const ns of fs.readdirSync(path.join(LOCALES, lng)).filter((f) => f.endsWith('.json'))) {
            const raw = fs.readFileSync(path.join(LOCALES, lng, ns), 'utf8');
            expect(raw.charCodeAt(0), `${lng}/${ns}`).not.toBe(0xfeff);
            expect(() => JSON.parse(raw), `${lng}/${ns}`).not.toThrow();
        }
    });

    it.each(languages)('%s garde les paires de pluriel completes', (lng) => {
        const orphans: string[] = [];
        for (const ns of fs.readdirSync(path.join(LOCALES, lng)).filter((f) => f.endsWith('.json'))) {
            const keys = flatten(read(lng, ns));
            for (const key of keys) {
                if (key.endsWith('_one') && !keys.includes(`${key.slice(0, -4)}_other`)) orphans.push(`${ns}:${key}`);
                if (key.endsWith('_other') && !keys.includes(`${key.slice(0, -6)}_one`)) orphans.push(`${ns}:${key}`);
            }
        }
        expect(orphans).toEqual([]);
    });

    // Une traduction partielle est acceptee, elle retombe sur l'anglais cle par
    // cle. Ce qui n'est pas accepte, c'est une cle inventee qui ne correspond a
    // rien : elle ne s'affichera jamais et cache souvent une faute de frappe.
    it.each(others.length ? others : ['(aucune)'])('%s n invente pas de cle absente du francais', (lng) => {
        if (lng === '(aucune)') return;
        const unknown: string[] = [];
        for (const ns of fs.readdirSync(path.join(LOCALES, lng)).filter((f) => f.endsWith('.json'))) {
            if (!namespaces.includes(ns)) { unknown.push(`${ns} (espace de noms inconnu)`); continue; }
            const reference = flatten(read('fr', ns));
            for (const key of flatten(read(lng, ns))) {
                if (!reference.includes(key)) unknown.push(`${ns}:${key}`);
            }
        }
        expect(unknown).toEqual([]);
    });

    it.each(others.length ? others : ['(aucune)'])('%s garde les variables du francais la ou elle traduit', (lng) => {
        if (lng === '(aucune)') return;
        const broken: string[] = [];
        for (const ns of fs.readdirSync(path.join(LOCALES, lng)).filter((f) => f.endsWith('.json'))) {
            if (!namespaces.includes(ns)) continue;
            const fr = read('fr', ns);
            const other = read(lng, ns);
            for (const key of flatten(other)) {
                const expected = placeholders(valueAt(fr, key)).join(',');
                const actual = placeholders(valueAt(other, key)).join(',');
                if (expected !== actual) broken.push(`${ns}:${key} attend ${expected || 'rien'}, trouve ${actual || 'rien'}`);
            }
        }
        expect(broken).toEqual([]);
    });
});
