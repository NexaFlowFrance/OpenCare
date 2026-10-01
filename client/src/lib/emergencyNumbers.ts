/**
 * Numeros d'urgence imprimes sur l'affiche de la fiche urgence.
 *
 * Le cercle les saisit dans Parametres, Langue et region (reglage
 * emergency_numbers). Sans saisie, un cercle francophone garde l'affiche
 * d'origine (SAMU 15, Pompiers 18) ; dans une autre langue, rien n'est
 * imprime : un mauvais numero sur une affiche d'urgence est pire que pas de
 * numero, et la langue de l'interface ne dit pas dans quel pays vit le proche.
 */

export const MAX_EMERGENCY_NUMBERS_LENGTH = 80;

/** L'affiche historique, pour les cercles francophones sans reglage. */
export const FRENCH_DEFAULT_NUMBERS = 'SAMU 15, Pompiers 18';

/** Le reglage du cercle, ou null s'il n'a rien saisi. */
export const circleEmergencyNumbers = (
    circle: { settings?: { emergency_numbers?: unknown } } | null | undefined
): string | null => {
    const value = circle?.settings?.emergency_numbers;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** Ce que l'affiche imprime, ou null pour ne pas afficher de ligne. */
export const posterEmergencyNumbers = (
    circle: { settings?: { emergency_numbers?: unknown } } | null | undefined,
    language: string
): string | null =>
    circleEmergencyNumbers(circle) ?? (language.toLowerCase().startsWith('fr') ? FRENCH_DEFAULT_NUMBERS : null);
