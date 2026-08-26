# VoxNote — contexte projet

PWA d'enregistrement vocal et de transcription. Trois choses, très bien :
enregistrer, transcrire, restituer le texte (copier / partager / exporter).

## Périmètre v1 (strict)
Dans le périmètre : accès protégé par un mot de passe unique partagé, enregistrement
segmenté avec pause/reprise, transcription serveur (fr, nl, en, détection auto),
liste de notes, transcript éditable, Copier, Partager (Web Share + fallback mailto),
export .txt et .md.

Hors périmètre v1, à refuser : comptes utilisateurs individuels, inscription, page
d'administration, base de données, OAuth, synchronisation des notes entre appareils,
résumés IA, diarisation, traduction, app native. Les notes restent local-first.

## Stack imposée
- Next.js (App Router), TypeScript strict, Tailwind, déployé sur Vercel.
- PWA : manifest + service worker (vérifier la lib à jour via Context7).
- Client : IndexedDB (idb). Serveur : Vercel Blob, upload client direct.
- Transcription : interface `TranscriptionProvider`, implémentations `groq`,
  `openai`, `gladia`. Sélection par `TRANSCRIBE_PROVIDER`. Défaut retenu : `groq`.
- Accès : mot de passe unique haché dans `APP_PASSWORD_HASH`, cookie de session JWT
  signé avec `AUTH_SECRET` (`jose`). Aucune base de données.
- PWA : `@serwist/next` (next-pwa n'est plus maintenu).
- Tests : vitest (unit) + Playwright (chromium desktop, chromium mobile, webkit mobile).
- CI : GitHub Actions (lint, typecheck, tests) sur chaque PR.

## Contraintes non négociables
1. Lire la skill `audio-web` avant tout code audio et l'appliquer.
2. Aucun secret côté client ni dans le repo. Clés API en variables d'environnement Vercel.
3. L'audio ne transite jamais par une route API (limite de body ~4,5 Mo) : Blob direct.
4. Enregistrement segmenté (~5 min), persisté en IndexedDB avant upload, queue avec
   retry : zéro perte sur refresh ou coupure réseau.
5. RGPD : supprimer une note supprime audio + texte ; purge auto des audios > 7 jours ;
   page confidentialité.
6. Interface en français, messages d'erreur compréhensibles par un non-technicien.
7. Aucune page ni route API accessible sans session valide, hors `/login`,
   `/confidentialite`, les assets et le cron. Aucun secret n'a de valeur par défaut :
   `AUTH_SECRET` ou `APP_PASSWORD_HASH` manquant = échec explicite au démarrage.

## Organisation
La session principale est ORCHESTRATEUR : elle découpe, délègue, vérifie, intègre.
Elle n'écrit pas le code de feature.

| Sous-agent | Périmètre |
|---|---|
| `dev-frontend` | UI, capture audio, PWA |
| `dev-backend` | routes API, pipeline de transcription, Blob, cron de purge |
| `qa-tester` | tests vitest et Playwright, critères d'acceptation |
| `architecte-reviewer` | revue sécurité / archi / RGPD des diffs sensibles |
| `docs-devops` | README, CI, changelog, checklists de test manuel |

Ticket touchant frontend ET backend : figer d'abord le contrat d'API (types
partagés), puis lancer `dev-frontend` et `dev-backend` en parallèle dessus.

## Boucle par ticket
1. Rédiger le ticket : objectif, fichiers, critères d'acceptation testables.
2. Déléguer au sous-agent compétent.
3. `qa-tester` écrit et exécute les tests des critères d'acceptation.
4. Sécurité / audio / upload / données touchés → diff à `architecte-reviewer`.
5. FAIL ou BLOQUANT → retour au développeur avec le rapport. Maximum 3 itérations,
   ensuite stop et exposé du blocage avec 2 options.
6. PASS → commit conventionnel, ticket suivant.

## Règles générales
- Vérifier les API des librairies via Context7 avant de les utiliser.
- Conventional commits, une PR par phase.
- STOP obligatoire en fin de phase : démo + rapport court, attendre validation explicite.
- Une exigence contradictoire ou risquée se signale AVANT implémentation, avec
  une recommandation.

## Documents de cadrage
`docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/PROVIDER-TRANSCRIPTION.md`,
`docs/BACKLOG.md`, `docs/RISQUES.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
