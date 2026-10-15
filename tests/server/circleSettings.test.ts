import { describe, it, expect } from 'vitest';
import {
    publicSettings, withPublicSettings, validateSettingsPatch, effectiveAidTypes, cleanAidType, PUBLIC_SETTING_KEYS,
} from '../../server/src/lib/circleSettings';

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
        expect(filtered).toEqual({ unit_system: 'imperial', week_start: 'monday', emergency_numbers: null, aid_types: null });
        expect(JSON.stringify(filtered)).not.toContain('2b$10');
    });

    it('donne une valeur par defaut utilisable', () => {
        const defaults = { unit_system: 'metric', week_start: 'monday', emergency_numbers: null, aid_types: null };
        expect(publicSettings({})).toEqual(defaults);
        expect(publicSettings(null)).toEqual(defaults);
        expect(publicSettings('texte')).toEqual(defaults);
        expect(publicSettings({ unit_system: 'lunaire', week_start: 'mardi' })).toEqual(defaults);
    });

    it('garde le dimanche quand le cercle l a choisi', () => {
        expect(publicSettings({ week_start: 'sunday' })).toEqual({ unit_system: 'metric', week_start: 'sunday', emergency_numbers: null, aid_types: null });
    });

    it('filtre aussi une ligne de cercle entiere, sans perdre le reste', () => {
        const row = { id: 'c1', name: 'Jeanne', settings: { unit_system: 'imperial', kiosk_pin_hash: 'secret' } };
        const safe = withPublicSettings(row);
        expect(safe.id).toBe('c1');
        expect(safe.name).toBe('Jeanne');
        expect(safe.settings).toEqual({ unit_system: 'imperial', week_start: 'monday', emergency_numbers: null, aid_types: null });
        expect(JSON.stringify(safe)).not.toContain('secret');
    });
});

describe('validateSettingsPatch', () => {
    it('accepte les deux systemes d unites', () => {
        expect(validateSettingsPatch({ unit_system: 'imperial' }, 'fr').patch).toEqual({ unit_system: 'imperial' });
        expect(validateSettingsPatch({ unit_system: 'metric' }, 'fr').patch).toEqual({ unit_system: 'metric' });
    });

    it('accepte les deux premiers jours de semaine, seuls ou avec les unites', () => {
        expect(validateSettingsPatch({ week_start: 'sunday' }, 'fr').patch).toEqual({ week_start: 'sunday' });
        expect(validateSettingsPatch({ week_start: 'monday' }, 'en').patch).toEqual({ week_start: 'monday' });
        expect(validateSettingsPatch({ unit_system: 'imperial', week_start: 'sunday' }, 'en').patch)
            .toEqual({ unit_system: 'imperial', week_start: 'sunday' });
    });

    it('refuse un premier jour de semaine inconnu', () => {
        expect(validateSettingsPatch({ week_start: 'saturday' }, 'fr').error).toBeTruthy();
        expect(validateSettingsPatch({ week_start: 0 }, 'en').error).toMatch(/monday or sunday/);
    });

    it('accepte des numeros d urgence courts, nettoyes, et les efface avec null ou ""', () => {
        expect(validateSettingsPatch({ emergency_numbers: '  911  ' }, 'en').patch).toEqual({ emergency_numbers: '911' });
        expect(validateSettingsPatch({ emergency_numbers: 'SAMU 15, Pompiers 18, 112' }, 'fr').patch)
            .toEqual({ emergency_numbers: 'SAMU 15, Pompiers 18, 112' });
        expect(validateSettingsPatch({ emergency_numbers: null, aid_types: null }, 'fr').patch).toEqual({ emergency_numbers: null, aid_types: null });
        expect(validateSettingsPatch({ emergency_numbers: '   ' }, 'fr').patch).toEqual({ emergency_numbers: null });
    });

    it('refuse des numeros d urgence trop longs, sur plusieurs lignes ou qui ne sont pas du texte', () => {
        expect(validateSettingsPatch({ emergency_numbers: '9'.repeat(81) }, 'en').error).toMatch(/at most 80/);
        expect(validateSettingsPatch({ emergency_numbers: '911\n112' }, 'fr').error).toBeTruthy();
        expect(validateSettingsPatch({ emergency_numbers: 911 }, 'en').error).toBeTruthy();
    });

    it('relit les numeros d urgence enregistres, et ignore une valeur abimee', () => {
        expect(publicSettings({ emergency_numbers: '911' }).emergency_numbers).toBe('911');
        expect(publicSettings({ emergency_numbers: '9'.repeat(200) }).emergency_numbers).toBeNull();
        expect(publicSettings({ emergency_numbers: 42 }).emergency_numbers).toBeNull();
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
        expect([...PUBLIC_SETTING_KEYS]).toEqual(['unit_system', 'week_start', 'emergency_numbers', 'aid_types']);
    });
});

describe('aid_types', () => {
    it('garde la liste saisie, nettoyee', () => {
        expect(validateSettingsPatch({ aid_types: ['  Medicaid ', 'VA   benefits', 'tax_credit'] }, 'en').patch)
            .toEqual({ aid_types: ['Medicaid', 'VA benefits', 'tax_credit'] });
    });

    it('revient a la liste par defaut avec null ou une liste vide', () => {
        expect(validateSettingsPatch({ aid_types: null }, 'en').patch).toEqual({ aid_types: null });
        expect(validateSettingsPatch({ aid_types: [] }, 'en').patch).toEqual({ aid_types: null });
        expect(effectiveAidTypes({ aid_types: null })).toEqual(['apa', 'cesu', 'tax_credit', 'other']);
        expect(effectiveAidTypes({ aid_types: ['Medicaid'] })).toEqual(['Medicaid']);
    });

    it('refuse un doublon, une valeur invalide ou une liste trop longue', () => {
        expect(validateSettingsPatch({ aid_types: ['Medicaid', 'medicaid'] }, 'en').error).toBeTruthy();
        expect(validateSettingsPatch({ aid_types: 'Medicaid' }, 'en').error).toBeTruthy();
        expect(validateSettingsPatch({ aid_types: ['ok', 42] }, 'en').error).toBeTruthy();
        expect(validateSettingsPatch({ aid_types: ['bip\u0007'] }, 'en').error).toBeTruthy();
        expect(validateSettingsPatch({ aid_types: ['x'.repeat(41)] }, 'en').error).toBeTruthy();
        expect(validateSettingsPatch({ aid_types: Array.from({ length: 16 }, (_, i) => `T${i}`) }, 'en').error).toBeTruthy();
    });

    it('ne laisse sortir qu une liste valide', () => {
        expect(publicSettings({ aid_types: ['Medicaid'] }).aid_types).toEqual(['Medicaid']);
        expect(publicSettings({ aid_types: 'Medicaid' }).aid_types).toBeNull();
        expect(publicSettings({ aid_types: [] }).aid_types).toBeNull();
    });

    it('nettoie un type isole', () => {
        expect(cleanAidType('  Long-term care  insurance ')).toBe('Long-term care insurance');
        expect(cleanAidType('')).toBeNull();
        expect(cleanAidType(7)).toBeNull();
    });
});
