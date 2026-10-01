import { describe, it, expect } from 'vitest';
import {
    circleEmergencyNumbers, posterEmergencyNumbers, FRENCH_DEFAULT_NUMBERS,
} from '../../client/src/lib/emergencyNumbers';

/**
 * L'affiche de la fiche urgence est lue dans l'urgence, parfois par un
 * inconnu : elle doit imprimer les numeros du cercle, et jamais ceux d'un
 * autre pays par defaut.
 */

describe('numeros d urgence de l affiche', () => {
    it('imprime le reglage du cercle, quelle que soit la langue', () => {
        const circle = { settings: { emergency_numbers: '911' } };
        expect(posterEmergencyNumbers(circle, 'en')).toBe('911');
        expect(posterEmergencyNumbers(circle, 'fr')).toBe('911');
        expect(posterEmergencyNumbers(circle, 'es')).toBe('911');
    });

    it('garde l affiche d origine pour un cercle francophone sans reglage', () => {
        expect(posterEmergencyNumbers({ settings: {} }, 'fr')).toBe(FRENCH_DEFAULT_NUMBERS);
        expect(posterEmergencyNumbers(null, 'fr-FR')).toBe(FRENCH_DEFAULT_NUMBERS);
    });

    it('n imprime aucun numero dans une autre langue sans reglage', () => {
        expect(posterEmergencyNumbers({ settings: {} }, 'en')).toBeNull();
        expect(posterEmergencyNumbers({ settings: { emergency_numbers: null } }, 'es')).toBeNull();
    });

    it('traite un reglage vide ou abime comme absent', () => {
        expect(circleEmergencyNumbers({ settings: { emergency_numbers: '   ' } })).toBeNull();
        expect(circleEmergencyNumbers({ settings: { emergency_numbers: 911 } })).toBeNull();
        expect(circleEmergencyNumbers({ settings: { emergency_numbers: ' 112 ' } })).toBe('112');
    });
});
