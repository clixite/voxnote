# Backlog VoxNote — v1

Convention : `[P{phase}-{n}]` · agent responsable · critères d'acceptation testables.
Un ticket n'est PASS que si `qa-tester` a rendu PASS sur tous ses critères.
Tickets marqués 🔒 : diff obligatoirement relu par `architecte-reviewer`.

---

## PHASE 1 — Socle

**[P1-1] Initialisation Next.js + TypeScript strict + Tailwind** · `dev-frontend`
- `pnpm dev` démarre, page d'accueil « VoxNote » affichée.
- `tsconfig.json` : `strict: true`, `noUncheckedIndexedAccess: true`.
- `pnpm typecheck` et `pnpm lint` passent sans erreur ni warning.

**[P1-2] Coquille PWA installable** · `dev-frontend`
- `manifest.webmanifest` complet (name, short_name, icônes 192/512 + maskable, theme_color, display standalone).
- Service worker enregistré, shell de l'app disponible hors ligne.
- Chrome desktop propose l'installation ; l'app installée s'ouvre sans barre d'adresse.
- Lighthouse : critère « installable » vert.

**[P1-3] Squelette de tests** · `qa-tester`
- vitest configuré, un test d'exemple passe.
- Playwright configuré avec 3 projets : `chromium-desktop`, `chromium-mobile` (Pixel 5), `webkit-mobile` (iPhone 13).
- Un e2e « la page d'accueil s'affiche » passe sur les 3 projets.

**[P1-4] CI GitHub Actions** · `docs-devops`
- Workflow sur chaque PR : install, lint, typecheck, test unit, build.
- La CI est verte sur la PR de la phase 1.

**[P1-5] Projet Vercel + preview** · `docs-devops` 🔒
- Projet créé via le MCP Vercel, relié au dépôt GitHub.
- URL de preview fonctionnelle sur la branche de la phase.
- Variables d'environnement déclarées (vides à ce stade) : `TRANSCRIBE_PROVIDER`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `GLADIA_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`.
- Aucun secret dans le dépôt (`git grep` sur les préfixes de clés : rien).

**DoD Phase 1** : l'app coquille vide s'installe sur le bureau Windows, écran d'accueil affiché, CI verte, URL de preview fonctionnelle.

---

## PHASE 2 — Capture audio

**[P2-1] Couche IndexedDB (idb)** · `dev-frontend` 🔒
- Stores `notes`, `segments`, `transcripts` conformes à `docs/ARCHITECTURE.md`.
- API typée : `createNote`, `appendSegment`, `listNotes`, `getNote`, `deleteNote`.
- Tests vitest avec fake-indexeddb, y compris la reprise après « rechargement ».

**[P2-2] Hook `useRecorder`** · `dev-frontend` 🔒
- mimeType choisi par `MediaRecorder.isTypeSupported`, jamais par user-agent ; stocké avec le segment.
- `timeslice` produisant des segments d'environ 5 min ; chaque segment persisté en IndexedDB **avant** tout upload.
- Pause / reprise sans perte ni segment corrompu.
- `getUserMedia` uniquement sur geste utilisateur ; `AudioContext.resume()` géré.
- Tests vitest sur la machine à états (idle → recording → paused → stopped).

**[P2-3] Wake lock + bandeau d'avertissement** · `dev-frontend`
- `navigator.wakeLock.request('screen')` demandé au démarrage, relâché à l'arrêt, re-demandé au retour au premier plan.
- Si l'API est absente (Safari ancien) : bandeau « garde l'écran allumé pendant l'enregistrement », pas d'erreur.

**[P2-4] UI d'enregistrement (bouton, compteur, VU-mètre)** · `dev-frontend`
- Un bouton principal large, atteignable au pouce ; compteur mm:ss ; VU-mètre réactif.
- Refus de permission micro → message en français expliquant comment réactiver le micro, aucune trace technique visible.
- Contrastes et labels accessibles.

**[P2-5] Tests e2e capture** · `qa-tester`
- Fake media stream Playwright ; enregistrement de 30 min simulé : tous les segments présents, aucun trou dans la séquence.
- Refresh en cours d'enregistrement : les segments déjà fermés sont conservés.
- Permission refusée : message attendu affiché.
- Enregistrement de 2 s : note créée, pas de crash.
- PASS requis sur les 3 projets Playwright.

**DoD Phase 2** : enregistrement de 30 min simulé sans perte de segment ; e2e permission refusée et refresh en cours d'enregistrement passent sur les 3 projets.

---

## PHASE 3 — Pipeline de transcription

**[P3-0] Contrat d'API partagé** · orchestrateur (avant de paralléliser)
- Types partagés `src/types/api.ts` : payloads et réponses de `upload-url`, `transcribe`, `transcribe/[jobId]`, `notes/[id]`.
- Validé par `dev-frontend` et `dev-backend` avant écriture de code.

**[P3-1] `POST /api/blob/upload-url`** · `dev-backend` 🔒
- Renvoie un token d'upload client Vercel Blob pour un chemin `audio/{noteId}/{seq}`.
- Valide `noteId`, `seq`, `mimeType` (liste blanche audio/webm, audio/mp4, audio/mpeg) et la taille annoncée (plafond par segment).
- Blob privé, non énumérable. Rate limiting.
- Test d'intégration : payload invalide → 400 avec message français ; payload valide → token.

**[P3-2] Interface `TranscriptionProvider` + 3 implémentations** · `dev-backend` 🔒
- Interface conforme à `docs/PROVIDER-TRANSCRIPTION.md`.
- `groq`, `openai`, `gladia` ; sélection par `TRANSCRIBE_PROVIDER`, valeur inconnue → erreur explicite au démarrage.
- Langue : auto par défaut, forçable en `fr` / `nl` / `en`.
- Retry exponentiel 3 tentatives sur erreurs `retryable`.
- Erreurs traduites en messages utilisateur français (quota, audio illisible, réseau, service indisponible).
- Tests unitaires avec provider mocké : succès, erreur retryable, erreur définitive.

**[P3-3] `POST /api/transcribe` + `GET /api/transcribe/[jobId]`** · `dev-backend` 🔒
- Reçoit **une URL de blob**, jamais un binaire (vérifié par un test qui envoie un body volumineux → refus).
- Statut par segment renvoyé au client ; assemblage ordonné par `seq`.
- Rate limiting. Tests d'intégration.

**[P3-4] Queue d'upload client avec retry** · `dev-frontend` 🔒
- File persistée : un segment `local` non uploadé est repris automatiquement au retour du réseau et après refresh.
- Backoff exponentiel, plafonné ; pas de boucle infinie sur erreur définitive.
- Tests vitest sur la file (succès, échec réseau, reprise).

**[P3-5] Progression visible dans l'UI** · `dev-frontend`
- Par note : segments uploadés / transcrits, état global lisible en un coup d'œil.
- Erreur par segment affichée en français avec action « réessayer ».

**[P3-6] Suppression + cron de purge** · `dev-backend` 🔒
- `DELETE /api/notes/[id]` : supprime les blobs de la note ; le client supprime segments et transcript en local.
- `GET /api/cron/purge` (Vercel Cron quotidien, protégé par `CRON_SECRET`) : supprime les blobs de plus de 7 jours.
- Tests : suppression vérifiée côté blob et côté client ; purge ne touche pas un blob récent.

**[P3-7] Tests e2e pipeline** · `qa-tester`
- Audio de 10 min : transcription complète, progression visible, texte assemblé dans l'ordre.
- Coupure réseau pendant l'upload puis retour : reprise automatique, aucun segment perdu.
- Suppression d'une note : blob et texte absents ensuite.

**DoD Phase 3** : audio de 10 min transcrit avec progression visible ; coupure réseau pendant l'upload reprise automatiquement ; suppression vérifiée blob + texte.

---

## PHASE 4 — Restitution et partage

**[P4-1] Liste des notes** · `dev-frontend`
- Titre auto = date + premiers mots du transcript ; état (en cours, transcrit, erreur) visible.
- Tri antéchronologique ; liste utilisable à 200 notes sans ralentissement perceptible.

**[P4-2] Vue transcript éditable** · `dev-frontend`
- Édition persistée en IndexedDB (debounce), survit au refresh.
- Lecture confortable sur écran de téléphone.

**[P4-3] Copier** · `dev-frontend`
- Bouton Copier visible sans scroll ; confirmation visuelle.
- Transcript de 10 000 mots copié intégralement (test e2e comparant longueur copiée et longueur source).

**[P4-4] Partager + export** · `dev-frontend`
- `navigator.share` si disponible ; fallback Clipboard API + `mailto:`.
- Export `.txt` et `.md` (le `.md` contient titre, date, durée).
- e2e partage sur viewport mobile.

**DoD Phase 4** : copier un transcript de 10 000 mots sans perte ; partage e2e sur viewport mobile ; édition persistée.

---

## PHASE 5 — Durcissement

**[P5-1] Passe e2e complète** · `qa-tester`
- Toute la suite verte sur les 3 projets Playwright, deux exécutions consécutives (chasse aux tests instables).

**[P5-2] Mode offline** · `dev-frontend`
- Notes déjà transcrites consultables hors ligne.
- Tentative de transcription hors ligne : message clair, mise en file, reprise au retour du réseau.

**[P5-3] Rate limiting et durcissement des routes** · `dev-backend` 🔒
- Limites en place sur `upload-url` et `transcribe` ; dépassement → 429 avec message français.
- Plafond de durée par note (2 h) appliqué côté client **et** côté serveur.

**[P5-4] Page confidentialité + revue RGPD** · `docs-devops` puis `architecte-reviewer` 🔒
- Page `/confidentialite` : quelles données, envoyées à qui, hébergées où, combien de temps, comment supprimer.
- Revue complète : zéro verdict BLOQUANT.

**[P5-5] Lighthouse** · `qa-tester`
- PWA installable ; performance > 90 sur mobile ; rapport joint.

**DoD Phase 5** : zéro verdict BLOQUANT ; Lighthouse PWA installable, performance > 90 mobile.

---

## PHASE 6 — Mise en production

**[P6-1] Déploiement production Vercel** · `docs-devops` 🔒
- Variables d'environnement de production renseignées ; provider de production conforme à l'arbitrage de Phase 0.
- URL de production fonctionnelle, cron de purge actif.

**[P6-2] README complet** · `docs-devops`
- Installation, variables d'environnement, lancement des tests, déploiement, architecture en un paragraphe.

**[P6-3] Checklist de test manuel sur vrais appareils** · `docs-devops`
- iPhone Safari : micro, verrouillage écran, installation PWA, partage, copier.
- Android Chrome : idem.
- Windows : installation desktop, micro, copier.
- Format : cases à cocher, une ligne par vérification, exécutable par le commanditaire.

**DoD Phase 6** : URL de production, README, checklist exécutable sur téléphones réels.
