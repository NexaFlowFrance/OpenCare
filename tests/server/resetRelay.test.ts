import { describe, it, expect } from 'vitest';
import { relayAdminIds, type Membership } from '../../server/src/lib/resetRelay';

/**
 * Sans SMTP, un lien de reinitialisation passe par un admin. Ce lien ouvre tout
 * le compte : l'admin d'un cercle partage ne doit pas pouvoir s'en servir pour
 * entrer dans un autre cercle de la personne.
 */

const m = (user_id: string, circle_id: string, role: string): Membership => ({ user_id, circle_id, role });

describe('relayAdminIds', () => {
    it('autorise l admin du seul cercle de la personne', () => {
        const rows = [m('vicky', 'grandpa', 'family'), m('mallory', 'grandpa', 'admin')];
        expect(relayAdminIds(rows, 'vicky')).toEqual(['mallory']);
    });

    it('refuse l admin d un cercle partage quand la personne a un autre cercle', () => {
        const rows = [
            m('vicky', 'grandpa', 'family'), m('mallory', 'grandpa', 'admin'),
            m('vicky', 'mom', 'admin'),
        ];
        expect(relayAdminIds(rows, 'vicky')).toEqual([]);
    });

    it('autorise un admin present dans tous les cercles de la personne', () => {
        const rows = [
            m('vicky', 'grandpa', 'family'), m('mallory', 'grandpa', 'admin'), m('paul', 'grandpa', 'admin'),
            m('vicky', 'mom', 'viewer'), m('paul', 'mom', 'admin'),
        ];
        expect(relayAdminIds(rows, 'vicky')).toEqual(['paul']);
    });

    it('ne compte pas un role non admin dans un des cercles', () => {
        const rows = [
            m('vicky', 'grandpa', 'family'), m('paul', 'grandpa', 'admin'),
            m('vicky', 'mom', 'family'), m('paul', 'mom', 'family'),
        ];
        expect(relayAdminIds(rows, 'vicky')).toEqual([]);
    });

    it('n autorise jamais la personne elle-meme, ni personne si elle n a aucun cercle', () => {
        expect(relayAdminIds([m('vicky', 'grandpa', 'admin')], 'vicky')).toEqual([]);
        expect(relayAdminIds([m('paul', 'grandpa', 'admin')], 'vicky')).toEqual([]);
    });
});
