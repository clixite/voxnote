/**
 * Formatage pur de durée pour l'écran d'enregistrement. Aucune dépendance à
 * React ni au moteur d'enregistrement : juste de la présentation.
 */

/**
 * `mm:ss` en dessous d'une heure, `h:mm:ss` au-delà (heures non paddées,
 * minutes et secondes toujours sur 2 chiffres). Toute valeur négative,
 * infinie ou `NaN` est traitée comme 0 — un compteur ne doit jamais afficher
 * autre chose qu'une durée plausible.
 */
export function formatDuration(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}
