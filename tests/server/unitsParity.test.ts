import { describe, it, expect } from 'vitest';
import * as server from '../../server/src/lib/units';
import * as client from '../../client/src/lib/units';

/**
 * Le serveur affiche lui aussi des constantes (alerte hors plage, synthese
 * hebdomadaire). Sa copie de la conversion doit rester identique a celle du
 * client : sinon une alerte et l'ecran Sante donneraient deux poids differents.
 */

const TYPES: server.VitalType[] = ['weight', 'bp', 'pain', 'mood', 'temperature', 'glucose'];
const SYSTEMS = ['metric', 'imperial'] as const;
const SAMPLES: Record<server.VitalType, number[]> = {
    weight: [0, 45.3, 68.04, 81.5, 120],
    bp: [78, 128, 150],
    pain: [0, 6, 10],
    mood: [1, 7],
    temperature: [35.2, 37, 38.65],
    glucose: [0.7, 1.04, 2.5],
};

describe('conversion serveur = conversion client', () => {
    for (const system of SYSTEMS) {
        for (const type of TYPES) {
            it(`${type} en ${system}`, () => {
                expect(server.displayUnit(type, system)).toBe(client.displayUnit(type, system));
                expect(server.decimalsFor(type, system)).toBe(client.decimalsFor(type, system));
                for (const value of SAMPLES[type]) {
                    expect(server.toDisplayValue(type, value, system)).toBe(client.toDisplayValue(type, value, system));
                    for (const locale of ['en-US', 'fr-FR']) {
                        expect(server.formatVital(type, value, type === 'bp' ? 80 : null, system, locale))
                            .toBe(client.formatVital(type, value, type === 'bp' ? 80 : null, system, locale));
                    }
                }
            });
        }
    }
});

describe('affichage cote serveur', () => {
    it('lit un poids stocke en kilos comme on l a saisi en livres', () => {
        expect(server.formatVital('weight', 68.04, null, 'imperial', 'en-US')).toBe('150 lb');
        expect(server.formatVital('weight', 68.04, null, 'metric', 'fr-FR')).toBe('68 kg');
    });

    it('arrondit une moyenne comme l ecran', () => {
        expect(server.roundedDisplayValue('weight', 68.04, 'imperial')).toBe(150);
        expect(server.roundedDisplayValue('glucose', 1.04, 'imperial')).toBe(104);
        expect(server.roundedDisplayValue('temperature', 37, 'imperial')).toBe(98.6);
        expect(server.roundedDisplayValue('bp', 128.4, 'imperial')).toBe(128);
    });

    it('choisit la locale des nombres selon la langue du compte', () => {
        expect(server.numberLocale('en')).toBe('en-US');
        expect(server.numberLocale('fr')).toBe('fr-FR');
        expect(server.numberLocale(null)).toBe('fr-FR');
    });

    it('reconnait les types de constantes', () => {
        expect(server.isVitalType('weight')).toBe(true);
        expect(server.isVitalType('height')).toBe(false);
    });
});
