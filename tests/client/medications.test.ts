import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { safeQuantity, unitFor, formatAmount, MEDICATION_UNITS, DEFAULT_UNIT_BY_FORM } from '../../client/src/lib/medications';

/**
 * La quantite affichee au proche ("Prends 2 comprimes") vient d'ici. Une
 * quantite fausse est une erreur de dosage, pas un defaut d'affichage.
 */

// i18next est remplace par une fonction minimale : on teste la mise en forme,
// pas la traduction, qui a son propre fichier de tests.
const fakeT = ((key: string, options?: { count?: number }) => {
    const unit = key.replace('medications:units.', '');
    const plural = (options?.count ?? 1) > 1;
    const labels: Record<string, [string, string]> = {
        tablet: ['comprimé', 'comprimés'],
        capsule: ['gélule', 'gélules'],
        ml: ['ml', 'ml'],
        drop: ['goutte', 'gouttes'],
        dose: ['dose', 'doses'],
    };
    const label = labels[unit];
    return label ? (plural ? label[1] : label[0]) : unit;
}) as never;

describe('safeQuantity', () => {
    it('lit aussi bien un nombre qu une chaine, comme les renvoie PostgreSQL', () => {
        expect(safeQuantity(2)).toBe(2);
        expect(safeQuantity('2.00')).toBe(2);
        expect(safeQuantity('0.5')).toBe(0.5);
    });

    it('retombe sur une dose quand la valeur est absurde, jamais sur zero', () => {
        for (const value of [null, undefined, 0, -3, 'deux', NaN]) {
            expect(safeQuantity(value as never), String(value)).toBe(1);
        }
    });
});

describe('unitFor', () => {
    it('prefere l unite de l horaire, sinon la deduit de la forme', () => {
        expect(unitFor('ml', 'tablet')).toBe('ml');
        expect(unitFor(null, 'syrup')).toBe(DEFAULT_UNIT_BY_FORM.syrup);
        expect(unitFor(null, 'tablet')).toBe('tablet');
    });

    it('finit toujours sur une unite connue', () => {
        expect(MEDICATION_UNITS).toContain(unitFor(null, 'forme-inconnue'));
        expect(unitFor(null, null)).toBe('dose');
    });
});

describe('formatAmount', () => {
    it('accorde l unite au nombre', () => {
        expect(formatAmount(fakeT, 1, 'tablet', 'tablet')).toBe('1 comprimé');
        expect(formatAmount(fakeT, 2, 'tablet', 'tablet')).toBe('2 comprimés');
        expect(formatAmount(fakeT, '3.00', null, 'capsule')).toBe('3 gélules');
    });

    it('ne rend pas une demi-dose en decimales inutiles', () => {
        expect(formatAmount(fakeT, 0.5, 'tablet', 'tablet')).toMatch(/^0[.,]5 comprimé$/);
        expect(formatAmount(fakeT, 10, 'ml', 'syrup')).toBe('10 ml');
    });
});

describe('copie du compagnon pour la demo', () => {
    it('reste identique au module du serveur', () => {
        // La demo statique n'a pas de serveur : elle rejoue la meme logique de
        // reponses. Si les deux fichiers divergent, la demo ment sur ce que
        // fait l'application.
        const root = path.resolve(__dirname, '../..');
        const server = fs.readFileSync(path.join(root, 'server/src/lib/companionAnswers.ts'), 'utf8');
        const demo = fs.readFileSync(path.join(root, 'client/src/demo/companionAnswers.ts'), 'utf8');
        expect(demo.replace(/\r\n/g, '\n')).toBe(server.replace(/\r\n/g, '\n'));
    });
});
