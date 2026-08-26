/**
 * Classification partagée des erreurs `@vercel/blob`, par `.name` plutôt que
 * par `instanceof` (même choix que `src/lib/recorder/errors.ts` pour un autre
 * store — ce module n'a pas besoin d'importer chaque classe concrète du SDK
 * pour rester correct).
 *
 * Utilisée à la fois par :
 * - `audio-source.ts` (`getBlobStream()`, téléchargement du segment pour un
 *   provider) ;
 * - `src/app/api/transcribe/route.ts` (`headBlob()`, garde anti-SSRF AVANT
 *   tout téléchargement).
 *
 * Les deux passent par `@/lib/blob/store` (revue C4, 2026-08-26) : c'est là
 * qu'un `BLOB_READ_WRITE_TOKEN` manquant ou invalide lève `BlobConfigError`
 * (`@/lib/blob/env`) — traité ici comme une mauvaise configuration, jamais
 * comme une panne transitoire.
 *
 * Point de revue (BLOQUANT B3, 2026-08-26) : le contrôle d'appartenance du
 * blob (`head()`) ne doit JAMAIS transformer une panne d'infrastructure
 * (service Blob indisponible, jeton momentanément invalide côté réseau, etc.)
 * en verdict définitif « ce lien n'est pas valide ». Seul un
 * `BlobNotFoundError` — le blob n'existe vraiment pas, ou dans le mauvais
 * store — justifie une réponse non réessayable ; toute autre erreur doit
 * rester réessayable (ou signaler une vraie mauvaise configuration), pour ne
 * pas condamner un segment déjà uploadé sur un simple aléa transitoire.
 */

import {
  audioUnreadableError,
  providerUnavailableError,
  serverMisconfiguredError,
  type TranscriptionError,
} from "./errors";

export function translateBlobError(error: unknown): TranscriptionError {
  const name = (error as { name?: string } | undefined)?.name;
  const detail = `Échec de l'appel Blob (${name ?? "erreur inconnue"}).`;

  switch (name) {
    // Le blob n'existe pas (ou plus) sous cette URL : ce n'est pas transitoire.
    case "BlobNotFoundError":
      return audioUnreadableError(detail);
    // Le jeton n'a plus accès à ce store, ou n'est pas configuré du tout
    // (`BlobConfigError`, levée par `getBlobConfig()` derrière `headBlob`/
    // `getBlobStream`) : problème d'exploitation, pas de fichier — ni le
    // client ni un réessai ne peuvent y faire quoi que ce soit. Le message de
    // `BlobConfigError` est déjà un diagnostic français précis (quelle
    // variable, où la configurer) : on le garde pour les logs plutôt que de
    // le remplacer par le gabarit générique.
    case "BlobConfigError":
      return serverMisconfiguredError(
        error instanceof Error ? error.message : detail,
      );
    case "BlobAccessError":
    case "BlobStoreNotFoundError":
      return serverMisconfiguredError(detail);
    // Panne ou limitation ponctuelle du service Blob lui-même : transitoire.
    case "BlobServiceRateLimited":
    case "BlobServiceNotAvailable":
      return providerUnavailableError(detail);
    default:
      // Erreur réseau ou inattendue : traitée comme transitoire par défaut —
      // ne jamais faire porter à l'utilisatrice le doute d'une panne qu'on
      // n'a pas su nommer précisément.
      return providerUnavailableError(detail);
  }
}
