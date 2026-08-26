/**
 * Détection du mimeType supporté par `MediaRecorder` À L'EXÉCUTION, jamais par
 * sniffing de user-agent (règle non négociable : CLAUDE.md #3, skill audio-web).
 *
 * Ordre de préférence et justification :
 *
 * 1. `audio/webm;codecs=opus` — Chrome, Edge, Firefox (desktop et Android) :
 *    Opus est le meilleur ratio qualité/taille pour de la voix, et c'est le
 *    conteneur natif de ces navigateurs (aucun réencodage requis).
 * 2. `audio/mp4;codecs=mp4a.40.2` — Safari (iOS et macOS) ne produit pas de
 *    webm ; AAC-LC explicite est le codec attendu pour un conteneur mp4 par
 *    les trois providers de transcription (Groq, OpenAI, Gladia).
 * 3. `audio/mp4` — repli si Safari refuse la chaîne de codec explicite
 *    (observé sur certaines versions qui n'acceptent que le type nu).
 * 4. `audio/webm` — repli Chromium/Firefox si la chaîne de codec explicite
 *    `;codecs=opus` est refusée (cas rare, versions anciennes).
 * 5. `audio/ogg;codecs=opus` — dernier repli (Firefox alternatif) : moins
 *    uniformément accepté par les trois providers que webm/opus ou mp4.
 *
 * Le mimeType retenu est figé pour toute la durée d'un enregistrement et
 * stocké avec chaque segment (voir `Segment.mimeType` dans src/types/notes.ts) :
 * un segment doit rester décodable seul, y compris par un autre provider.
 */
export const MIME_TYPE_CANDIDATES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

export type IsTypeSupportedFn = (type: string) => boolean;

/**
 * Renvoie le premier mimeType supporté par `isTypeSupported`, ou `undefined`
 * si aucun candidat n'est supporté (navigateur incompatible).
 */
export function pickSupportedMimeType(
  isTypeSupported: IsTypeSupportedFn,
  candidates: readonly string[] = MIME_TYPE_CANDIDATES,
): string | undefined {
  return candidates.find((candidate) => {
    try {
      return isTypeSupported(candidate);
    } catch {
      // Un navigateur capricieux qui lève au lieu de renvoyer `false` ne doit
      // pas faire planter la détection : on passe au candidat suivant.
      return false;
    }
  });
}
