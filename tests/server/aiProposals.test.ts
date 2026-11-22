import { describe, it, expect } from 'vitest';
import { validateParsedItems } from '../../server/src/services/ai/assistant';

/**
 * Les propositions de la saisie magique sont postees telles quelles sur les
 * routes existantes : une categorie que la route refuse (ou ne sait pas
 * afficher) fait echouer la validation cote aidant.
 */

const parse = (item: Record<string, unknown>) => validateParsedItems({ items: [{ title: 'x', ...item }] }, []);

describe('validateParsedItems', () => {
    it('garde une categorie de depense acceptee par /api/expenses', () => {
        expect(parse({ type: 'budget_entry', amount: 23.5, category: 'pharmacy' })[0]).toMatchObject({ category: 'pharmacy' });
    });

    it('ramene une categorie de depense inconnue sur other', () => {
        expect(parse({ type: 'budget_entry', amount: 23.5, category: 'Pharmacie' })[0]).toMatchObject({ category: 'other' });
    });

    it('ecarte une recette : les depenses partagees n en ont pas', () => {
        expect(parse({ type: 'budget_entry', amount: 50, category: 'other', is_expense: false })).toEqual([]);
    });

    it('range les courses dans les categories de la liste', () => {
        expect(parse({ type: 'shopping_item', category: 'food' })[0]).toMatchObject({ category: 'food' });
        expect(parse({ type: 'shopping_item', category: 'Alimentation' })[0]).toMatchObject({ category: 'other' });
    });
});
