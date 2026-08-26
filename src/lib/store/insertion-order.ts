/**
 * Horloge d'insertion : fournit un nombre strictement croissant, basé sur
 * l'horloge murale, pour ordonner « par ancienneté » des enregistrements qui
 * n'ont pas de champ de date dans le contrat public (`Segment` n'a pas de
 * `createdAt` — voir `src/types/notes.ts`).
 *
 * Basé sur `Date.now()` plutôt que sur un compteur en mémoire pur : la valeur
 * reste significative même après réouverture de la base (un vrai refresh de
 * page réinitialise le compteur, pas l'horloge). Le compteur ne sert qu'à
 * départager deux insertions survenues dans la même milliseconde.
 */
export function createInsertionClock(): () => number {
  let last = 0;
  return () => {
    const now = Date.now();
    last = now > last ? now : last + 1;
    return last;
  };
}
