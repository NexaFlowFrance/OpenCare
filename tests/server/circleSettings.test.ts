import { describe, it, expect } from 'vitest';
import { publicSettings, withPublicSettings, validateSettingsPatch, PUBLIC_SETTING_KEYS } from '../../server/src/lib/circleSettings';

/**
 * care_circles.settings melange des preferences lisibles par tout le cercle et
 * l'empreinte du code aidant du mode Kiosk. Un code a quatre chiffres dont
 * l'empreinte circule se casse hors ligne en quelques secondes : rien d'autre
 * que les cles publiques ne doit sortir, et une ecriture ne doit jamais
 * effacer ce qu'elle ne connait pas.
 */

describe('publicSettings', () => {
    it('ne laisse sortir que les cles publiques', () => {
        const filtered = publicSettings({
            unit_system: 'imperial',
            kiosk_pin_hash: '$2b$10$uneEmpreinteQuiNeDoitPasSortir',
            secret_futur: 'jamais',
        });
        expect(filtered).toEqual({ unit_system: 'imperial' });
        expect(JSON.stringify(filtered)).not.toContain('2b$10');
    });

    it('donne une valeur par defaut utilisable', () => {
        expect(publicSettings({})).toEqual({ unit_system: 'metric' });
        expect(publicSettings(null)).toEqual({ unit_system: 'metric' });
        expect(publicSettings('texte')).toEqual({ unit_system: 'metric' });
        expect(publicSettings({ unit_system: 'lunaire' })).toEqual({ unit_system: 'metric' });
    });

    it('filtre aussi une ligne de cercle entiere, sans perdre le reste', () => {
        const row = { id: 'c1', name: 'Jeanne', settings: { unit_system: 'imperial', kiosk_pin_hash: 'secret' } };
        const safe = withPublicSettings(row);
        expect(safe.id).toBe('c1');
        expect(safe.name).toBe('Jeanne');
        expect(safe.settings).toEqual({ unit_system: 'imperial' });
        expect(JSON.stringify(safe)).not.toContain('secret');
    });
});

describe('validateSettingsPatch', () => {
    it('accepte les deux systemes d unites', () => {
        expect(validateSettingsPatch({ unit_system: 'imperial' }, 'fr').patch).toEqual({ unit_system: 'imperial' });
        expect(validateSettingsPatch({ unit_system: 'metric' }, 'fr').patch).toEqual({ unit_system: 'metric' });
    });

    it('refuse une valeur inconnue plutot que de l ignorer', () => {
        expect(validateSettingsPatch({ unit_system: 'lunaire' }, 'fr').error).toBeTruthy();
        expect(validateSettingsPatch({ unit_system: 42 }, 'en').error).toMatch(/metric or imperial/);
    });

    it('refuse une cle inconnue, et surtout une cle privee', () => {
        expect(validateSettingsPatch({ kiosk_pin_hash: 'a-moi' }, 'fr').error).toBeTruthy();
        expect(validateSettingsPatch({ inconnue: true }, 'en').error).toMatch(/Unknown setting/);
    });

    it('refuse ce qui n est pas un objet', () => {
        expect(validateSettingsPatch(null, 'fr').error).toBeTruthy();
        expect(validateSettingsPatch(['metric'], 'fr').error).toBeTruthy();
        expect(validateSettingsPatch('metric', 'en').error).toBeTruthy();
    });

    it('accepte un objet vide, qui ne change rien', () => {
        expect(validateSettingsPatch({}, 'fr')).toEqual({ patch: {} });
    });

    it('ne declare publique que ce qui a ete relu', () => {
        expect([...PUBLIC_SETTING_KEYS]).toEqual(['unit_system']);
    });
});
