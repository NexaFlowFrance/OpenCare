import { describe, it, expect } from 'vitest';
import {
    displayUnit, storageUnit, toDisplayValue, toStorageValue, decimalsFor,
    formatValue, formatVital, toInputValue, type VitalType,
} from '../../client/src/lib/units';

/**
 * Les constantes sont enregistrees en metrique et affichees dans le systeme du
 * cercle. Une conversion fausse, c'est un poids ou une glycemie faux sur un
 * ecran de sante : l'aller-retour se teste.
 */

const TYPES: VitalType[] = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];

describe('unites affichees', () => {
    it('donne les unites metriques par defaut', () => {
        expect(displayUnit('weight', 'metric')).toBe('kg');
        expect(displayUnit('temperature', 'metric')).toBe('°C');
        expect(displayUnit('glucose', 'metric')).toBe('g/L');
        expect(displayUnit('bp', 'metric')).toBe('mmHg');
    });

    it('bascule les trois unites qui changent, et seulement celles-la', () => {
        expect(displayUnit('weight', 'imperial')).toBe('lb');
        expect(displayUnit('temperature', 'imperial')).toBe('°F');
        expect(displayUnit('glucose', 'imperial')).toBe('mg/dL');
        expect(displayUnit('bp', 'imperial')).toBe('mmHg');
        expect(displayUnit('pain', 'imperial')).toBe('/10');
        expect(displayUnit('mood', 'imperial')).toBe('/10');
    });

    it('enregistre toujours dans l unite metrique', () => {
        for (const type of TYPES) {
            expect(storageUnit(type), type).toBe(displayUnit(type, 'metric'));
        }
    });
});

describe('conversions', () => {
    it('convertit le poids', () => {
        expect(toDisplayValue('weight', 68.04, 'imperial')).toBeCloseTo(150, 1);
        expect(toStorageValue('weight', 150, 'imperial')).toBeCloseTo(68.04, 2);
    });

    it('convertit la temperature, y compris sous zero', () => {
        expect(toDisplayValue('temperature', 37, 'imperial')).toBeCloseTo(98.6, 1);
        expect(toDisplayValue('temperature', 0, 'imperial')).toBe(32);
        expect(toStorageValue('temperature', 98.6, 'imperial')).toBeCloseTo(37, 5);
    });

    it('convertit la glycemie', () => {
        expect(toDisplayValue('glucose', 1.04, 'imperial')).toBeCloseTo(104, 6);
        expect(toStorageValue('glucose', 104, 'imperial')).toBeCloseTo(1.04, 6);
    });

    it('laisse la tension, la douleur et le moral tranquilles', () => {
        for (const type of ['bp', 'pain', 'mood'] as VitalType[]) {
            expect(toDisplayValue(type, 128, 'imperial'), type).toBe(128);
            expect(toStorageValue(type, 128, 'imperial'), type).toBe(128);
        }
    });

    it('ne touche a rien en metrique', () => {
        for (const type of TYPES) {
            expect(toDisplayValue(type, 42.5, 'metric'), type).toBe(42.5);
            expect(toStorageValue(type, 42.5, 'metric'), type).toBe(42.5);
        }
    });

    it('revient a la valeur de depart apres un aller-retour', () => {
        for (const type of TYPES) {
            for (const value of [0.5, 1.04, 36.6, 58.2, 128]) {
                const round = toStorageValue(type, toDisplayValue(type, value, 'imperial'), 'imperial');
                expect(round, `${type} ${value}`).toBeCloseTo(value, 9);
            }
        }
    });
});

describe('mise en forme', () => {
    it('arrondit a ce qui se lit, pas a ce qui se calcule', () => {
        expect(decimalsFor('glucose', 'metric')).toBe(2);
        expect(decimalsFor('glucose', 'imperial')).toBe(0);
        expect(decimalsFor('bp', 'metric')).toBe(0);
        expect(formatValue('glucose', 1.04, 'imperial', 'en')).toBe('104');
        expect(formatValue('weight', 68.04, 'imperial', 'en')).toBe('150');
        expect(formatValue('temperature', 37, 'imperial', 'en')).toBe('98.6');
    });

    it('ecrit la mesure complete', () => {
        expect(formatVital('weight', 58.2, null, 'metric', 'en')).toBe('58.2 kg');
        expect(formatVital('weight', 68.04, null, 'imperial', 'en')).toBe('150 lb');
        expect(formatVital('bp', 128, 78, 'imperial', 'en')).toBe('128/78 mmHg');
        expect(formatVital('mood', 6, null, 'metric', 'en')).toBe('6/10');
        expect(formatVital('temperature', 38.2, null, 'imperial', 'en')).toBe('100.8 °F');
    });

    it('prepare un champ de saisie sans trainee de decimales', () => {
        expect(toInputValue('weight', 68.0388554, 'imperial')).toBe('150');
        expect(toInputValue('glucose', 1.04, 'metric')).toBe('1.04');
        expect(toInputValue('weight', null, 'imperial')).toBe('');
        expect(toInputValue('weight', Number.NaN, 'metric')).toBe('');
    });

    it('rend ce que la famille a tape, apres aller-retour par la base', () => {
        // Une famille americaine tape 150 lb : 68,0389 kg partent au serveur,
        // et l'ecran doit bien reafficher 150 lb, pas 149,9.
        const stored = toStorageValue('weight', 150, 'imperial');
        expect(formatVital('weight', stored, null, 'imperial', 'en')).toBe('150 lb');
        expect(formatVital('weight', stored, null, 'metric', 'en')).toBe('68 kg');
    });
});
