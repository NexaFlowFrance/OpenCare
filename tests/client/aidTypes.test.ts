import { describe, it, expect } from 'vitest';
import { aidTypeLabel, aidTypeOptions, circleAidTypes, cleanAidType } from '../../client/src/lib/aidTypes';

/**
 * Les types d'aides viennent du cercle. Une aide garde son type meme s'il a
 * ete retire de la liste : le formulaire doit encore le proposer, sinon
 * l'enregistrer changerait son type sans que personne ne l'ait choisi.
 */

const t = (key: string) => `[${key}]`;

describe('types d aides', () => {
    it('prend la liste du cercle, ou la liste francaise par defaut', () => {
        expect(circleAidTypes(null)).toEqual(['apa', 'cesu', 'tax_credit', 'other']);
        expect(circleAidTypes({ settings: {} })).toEqual(['apa', 'cesu', 'tax_credit', 'other']);
        expect(circleAidTypes({ settings: { aid_types: [] } })).toEqual(['apa', 'cesu', 'tax_credit', 'other']);
        expect(circleAidTypes({ settings: { aid_types: ['Medicaid', 'other'] } })).toEqual(['Medicaid', 'other']);
    });

    it('garde dans le formulaire le type retire d une aide existante', () => {
        expect(aidTypeOptions(['Medicaid'], 'apa')).toEqual(['Medicaid', 'apa']);
        expect(aidTypeOptions(['Medicaid'], 'Medicaid')).toEqual(['Medicaid']);
        expect(aidTypeOptions(['Medicaid'], null)).toEqual(['Medicaid']);
    });

    it('traduit les cles d origine et affiche les autres telles quelles', () => {
        expect(aidTypeLabel('apa', t)).toBe('[expenses:aids.types.apa]');
        expect(aidTypeLabel('VA benefits', t)).toBe('VA benefits');
        expect(aidTypeLabel('Note: aids.types.apa', t)).toBe('Note: aids.types.apa');
    });

    it('nettoie un type saisi comme le serveur', () => {
        expect(cleanAidType('  VA   benefits ')).toBe('VA benefits');
        expect(cleanAidType('   ')).toBeNull();
        expect(cleanAidType('x'.repeat(41))).toBeNull();
    });
});
