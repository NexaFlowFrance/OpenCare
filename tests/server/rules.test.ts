import { describe, it, expect } from 'vitest';
import { validateRules, DEFAULT_RULES } from '../../server/src/lib/escalation';
import { sanitizeSections, filledSections, CARE_PLAN_SECTION_KEYS, MAX_SECTION_CHARS } from '../../server/src/lib/carePlan';
import { pickLang, langFromRequest, t } from '../../server/src/lib/i18n';

/**
 * Trois garde-fous : ce qu'on accepte d'un client pour les regles d'escalade
 * et pour les consignes du plan de soins, et la langue dans laquelle le
 * serveur repond.
 */

describe('validateRules', () => {
    it('accepte une mise a jour partielle', () => {
        const { patch, error } = validateRules({ enabled: true, med_primary_min: 45 }, 'fr');
        expect(error).toBeUndefined();
        expect(patch).toEqual({ enabled: true, med_primary_min: 45 });
    });

    it('refuse des minutes qui n en sont pas', () => {
        for (const value of [-1, 1.5, 1441, 'vingt', null]) {
            const { error } = validateRules({ med_primary_min: value }, 'fr');
            expect(error, `valeur ${String(value)}`).toBeTruthy();
        }
        expect(validateRules({ med_primary_min: 0 }, 'fr').error).toBeUndefined();
        expect(validateRules({ med_primary_min: 1440 }, 'fr').error).toBeUndefined();
    });

    it('ne garde que des identifiants de membre credibles', () => {
        const { patch } = validateRules({
            primary_member_ids: ['ef4e079b-043d-4753-8a1c-3da6079da4ca', 'pas-un-uuid', 42, null],
        }, 'fr');
        expect(patch!.primary_member_ids).toEqual(['ef4e079b-043d-4753-8a1c-3da6079da4ca']);
    });

    it('traite toute valeur non booleenne de enabled comme un refus', () => {
        expect(validateRules({ enabled: 'oui' }, 'fr').patch).toEqual({ enabled: false });
    });

    it('refuse une entree qui n est pas un objet, et parle la langue demandee', () => {
        expect(validateRules(null, 'fr').error).toBeTruthy();
        expect(validateRules('rien', 'en').error).toMatch(/object/);
    });

    it('part desactive par defaut', () => {
        expect(DEFAULT_RULES.enabled).toBe(false);
    });
});

describe('sanitizeSections', () => {
    it('ne garde que les sections connues', () => {
        const sections = sanitizeSections({ morning: 'Lever a 7 h 30', inventee: 'ignoree', emergency: 'Appeler Marie' });
        expect(Object.keys(sections).sort()).toEqual(['emergency', 'morning']);
    });

    it('coupe les textes trop longs et nettoie les bords', () => {
        const sections = sanitizeSections({ meals: `  ${'x'.repeat(MAX_SECTION_CHARS + 500)}  ` });
        expect(sections.meals).toHaveLength(MAX_SECTION_CHARS);
    });

    it('ignore ce qui n est pas du texte', () => {
        expect(sanitizeSections({ morning: 42, meals: null, mobility: { a: 1 } })).toEqual({});
        expect(sanitizeSections(null)).toEqual({});
        expect(sanitizeSections('texte')).toEqual({});
    });

    it('couvre les huit sections attendues', () => {
        expect(CARE_PLAN_SECTION_KEYS).toHaveLength(8);
        const tout = Object.fromEntries(CARE_PLAN_SECTION_KEYS.map((k) => [k, 'valeur']));
        expect(Object.keys(sanitizeSections(tout))).toHaveLength(8);
    });
});

describe('filledSections', () => {
    it('laisse de cote les sections vides, pour ne pas afficher de titre sans contenu', () => {
        expect(filledSections({ morning: 'Lever a 7 h 30', meals: '', mobility: '   ' })).toEqual({ morning: 'Lever a 7 h 30' });
    });
});

describe('langue des reponses du serveur', () => {
    it('reconnait l anglais sous toutes ses formes, et retombe sur le francais', () => {
        expect(pickLang('en')).toBe('en');
        expect(pickLang('EN-US')).toBe('en');
        expect(pickLang('fr-FR')).toBe('fr');
        expect(pickLang(undefined)).toBe('fr');
        expect(pickLang(42)).toBe('fr');
    });

    it('prefere l en-tete de la requete au compte, puis le francais', () => {
        expect(langFromRequest({ headers: { 'accept-language': 'en-GB,en;q=0.9' } } as never)).toBe('en');
        expect(langFromRequest({ headers: {}, language: 'en' } as never)).toBe('en');
        expect(langFromRequest({ headers: {} } as never)).toBe('fr');
    });

    it('remplace les variables et ne casse pas sur une cle inconnue', () => {
        expect(t('fr', 'events.move_too_far', { days: 7 })).toContain('7 jours');
        expect(t('en', 'events.move_too_far', { days: 7 })).toContain('7 days');
        expect(t('fr', 'cle.inexistante')).toBe('cle.inexistante');
    });
});
