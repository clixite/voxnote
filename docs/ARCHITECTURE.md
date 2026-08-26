# Architecture VoxNote — v1

## Vue d'ensemble

```
┌───────────────────────────────────────────────────────────────────────────┐
│ NAVIGATEUR (PWA installée — Windows / iPhone Safari / Android Chrome)     │
│                                                                           │
│  ┌─────────────┐   segments   ┌──────────────┐   file d'attente          │
│  │ useRecorder │─────────────▶│  IndexedDB   │◀───────────┐              │
│  │ MediaRecorder│  (~5 min)   │   (idb)      │            │              │
│  │ + timeslice │              │ notes,       │            │              │
│  │ + wakeLock  │              │ segments,    │      ┌─────┴───────┐      │
│  │ + VU-mètre  │              │ transcripts  │      │ uploadQueue │      │
│  └─────────────┘              └──────────────┘      │ retry expo. │      │
│         │                            ▲              └─────┬───────┘      │
│         │  mimeType détecté          │ lecture/édition    │              │
│         ▼                            │                    │              │
│  ┌─────────────────────────────────────────────┐          │              │
│  │ UI Next.js (App Router, RSC + client comps) │          │              │
│  │ /  /note/[id]  /confidentialite             │          │              │
│  └─────────────────────────────────────────────┘          │              │
│         │                                                  │              │
│  ┌──────┴───────┐                                          │              │
│  │ Service Worker│ (shell + assets, notes consultables offline)          │
│  └──────────────┘                                          │              │
└────────────────────────────────────┬──────────────────────┬──────────────┘
                                     │                      │
                  (1) POST /api/blob/upload-url             │ (2) PUT direct
                      → token d'upload client               │  (jamais via API :
                                     │                      │   limite body ~4,5 Mo)
                                     ▼                      ▼
┌──────────────────────────────────────┐        ┌──────────────────────────┐
│ VERCEL — Next.js route handlers      │        │      VERCEL BLOB         │
│                                      │        │  audio/{noteId}/{seq}    │
│  POST /api/blob/upload-url           │        │  (privé, TTL 7 jours)    │
│  POST /api/transcribe   ← url du blob│───────▶│                          │
│  GET  /api/transcribe/[jobId]        │  fetch └──────────────────────────┘
│  DELETE /api/notes/[id]              │
│  GET  /api/cron/purge  (Vercel Cron) │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ TranscriptionProvider (iface)  │  │
│  │  ├─ GroqProvider   (défaut)    │  │
│  │  ├─ OpenAIProvider             │  │
│  │  └─ GladiaProvider  (UE)       │  │
│  │  sélection: TRANSCRIBE_PROVIDER│  │
│  └────────────────┬───────────────┘  │
└───────────────────┼──────────────────┘
                    │ HTTPS + clé API (env Vercel uniquement)
                    ▼
        ┌───────────────────────────────┐
        │ API de transcription externe  │
        │ Groq / OpenAI / Gladia        │
        └───────────────────────────────┘
```

## Flux nominal d'une note

```
tap "Enregistrer"
  └─ getUserMedia (geste utilisateur) + wakeLock + AudioContext.resume()
       └─ MediaRecorder(timeslice) ──▶ segment N ──▶ IndexedDB (statut: local)
                                              └────▶ uploadQueue
                                                       └─ upload-url ─▶ PUT Blob
                                                            └─ statut: uploaded
                                                                 └─ POST /api/transcribe
                                                                      └─ statut: transcribing
                                                                           └─ texte ─▶ IndexedDB
                                                                                └─ statut: done
tap "Arrêter"
  └─ flush du segment en cours ──▶ même chaîne
  └─ assemblage ordonné par `seq` ──▶ transcript complet affiché
```

L'assemblage est ordonné par le numéro de séquence du segment, pas par l'ordre
d'arrivée des réponses : les segments peuvent être transcrits en parallèle.

## Segmentation : redémarrer le MediaRecorder, ne pas utiliser `timeslice`

Piège qui n'est pas dans la skill `audio-web` et qui casserait toute la Phase 3
s'il était découvert tard.

`MediaRecorder.start(timeslice)` émet des morceaux successifs, mais **seul le
premier porte l'en-tête du conteneur**. Concaténés dans l'ordre, ils forment un
fichier valide ; pris isolément, les morceaux 2 à N ne sont pas décodables. Or
notre architecture repose précisément sur des segments indépendants : uploadés
séparément, transcrits séparément, éventuellement en parallèle. Avec `timeslice`,
seul le premier segment serait transcriptible et tous les autres reviendraient en
erreur « fichier illisible » — chez les trois providers.

La v1 découpe donc en **arrêtant et redémarrant le `MediaRecorder`** toutes les
~5 minutes, sur le même `MediaStream` (la piste micro n'est jamais relâchée, donc
aucun nouveau prompt de permission). Chaque cycle produit un fichier complet et
autonome.

```
getUserMedia ──▶ MediaStream (ouvert du début à la fin de l'enregistrement)
                      │
                      ├── MediaRecorder #0 ── start ─ 5 min ─ stop ─▶ segment 0 (fichier complet)
                      ├── MediaRecorder #1 ── start ─ 5 min ─ stop ─▶ segment 1 (fichier complet)
                      └── MediaRecorder #2 ── start ─── stop manuel ─▶ segment 2 (fichier complet)
```

Contrepartie assumée : la bascule laisse un trou de quelques dizaines de
millisecondes entre deux segments. Sur de la parole, c'est inaudible et sans effet
sur la transcription. La supprimer imposerait deux enregistreurs chevauchants et
une déduplication — complexité sans bénéfice pour l'usage visé.

Un `timeslice` court reste utilisé **à l'intérieur** d'un cycle, uniquement pour
récupérer les données au fil de l'eau et limiter ce qui est perdu si l'onglet meurt
au milieu d'un segment.

## Modèle de données (IndexedDB, source de vérité côté client)

```
note      { id, createdAt, title, lang, durationMs, status, updatedAt }
segment   { id, noteId, seq, blob, mimeType, durationMs, status, blobUrl?, error? }
transcript{ noteId, seq, text, provider, createdAt }
```

`status` de segment : `local` → `uploading` → `uploaded` → `transcribing` → `done` | `error`.
Le statut est calculé côté client à partir des segments ; le serveur est sans état
persistant hors le Blob (pas de base de données en v1).

## Décisions structurantes

| Décision | Raison | Alternative écartée |
|---|---|---|
| Aucune base de données | Un mot de passe partagé se vérifie contre une variable d'environnement | Table `users` — imposerait Postgres pour zéro bénéfice ici |
| Mot de passe unique plutôt que des comptes | Ferme la porte, ce qui est le besoin réel ; pas d'identité à gérer | NextAuth/Auth.js — dimensionné pour l'OAuth multi-fournisseurs |
| Upload client direct vers Blob | Limite de body ~4,5 Mo des fonctions serverless | Proxy via route API — casse au-delà de 4,5 Mo |
| Segmentation ~5 min | Borne la perte, contourne la limite de taille par fichier, permet la progression | Fichier unique — tout ou rien |
| IndexedDB avant upload | Un refresh ou un crash ne perd que le segment en cours | État en mémoire — perte totale |
| Interface `TranscriptionProvider` | Bascule UE ↔ US par variable d'environnement, sans refactor | Appel direct au SDK — verrou fournisseur |
| Transcription synchrone, un appel par segment | Sans base, un job asynchrone n'a nulle part où stocker son état ; le client le connaît déjà | Job + polling — réintroduirait une base ou mentirait sur l'état |
| Suppression et purge par préfixe de blob | Le serveur retrouve les blobs d'une note sans rien mémoriser | Liste d'URL fournie par le client — un oubli laisse de l'audio orphelin |
| Blob privé + TTL 7 jours | RGPD : minimisation et limitation de conservation | Blob public — URL devinable, fuite |

## Accès protégé par mot de passe unique

L'application est fermée : aucune page utile, aucune route API n'est accessible sans
session valide. Il n'y a ni compte, ni inscription, ni base de données — un seul mot
de passe partagé, dont seul le **hash** existe côté serveur, dans une variable
d'environnement Vercel.

```
   visiteur ──▶ middleware ──┬── cookie de session valide ? ──▶ page demandée
                             │
                             └── non ──▶ /login
                                          │ POST /api/auth/login { password }
                                          │   └─ bcrypt.compare(password, APP_PASSWORD_HASH)
                                          │   └─ throttling best-effort en mémoire
                                          ▼
                                  cookie `vox_session` (JWT HS256, jose)
                                  httpOnly · Secure · SameSite=Lax · 30 j
                                  { pv }   ← empreinte courte du hash en vigueur
```

Points de conception :

- **Le mot de passe n'est jamais stocké en clair**, ni dans le dépôt, ni en base, ni
  dans un fichier : seul `APP_PASSWORD_HASH` (bcrypt) existe, en variable
  d'environnement. Un script `pnpm hash-password` génère le hash localement.
- **Changer le mot de passe = changer la variable d'environnement**, puis redéployer.
  Le JWT porte `pv`, une empreinte courte du hash en vigueur : dès que le hash change,
  toutes les sessions émises avec l'ancien deviennent invalides. C'est la révocation
  du pauvre, et elle suffit — sans aucune table de sessions à purger.
- **`AUTH_SECRET` est obligatoire** et vérifié au démarrage. Aucune valeur par défaut,
  jamais : un secret par défaut committé permettrait de forger un cookie valide et
  rendrait le mot de passe décoratif.
- **Throttling best-effort** : compteur en mémoire par IP dans l'instance serverless.
  Il ne survit pas à un cold start et ne couvre pas plusieurs instances — c'est assumé.
  Le vrai frein est ailleurs : bcrypt est lent par construction (~100 ms par essai),
  ce qui rend le bruteforce en ligne peu rentable, à condition que le mot de passe
  soit long. D'où la consigne : une phrase de passe, pas un mot de huit lettres.
- **Aucune donnée personnelle n'est créée par l'auth** : pas d'email, pas de compte,
  pas de journal nominatif. Le RGPD s'en trouve simplifié, pas compliqué.

Contrepartie assumée : on ne sait pas *qui* s'est connecté, et révoquer l'accès d'une
seule personne est impossible — changer le mot de passe le change pour tout le monde.
Pour un cercle de quelques personnes de confiance, c'est le bon compromis. Le jour où
ça ne l'est plus, la marche suivante est une vraie table d'utilisateurs, donc une base.

## Sécurité et RGPD
- Clés API uniquement en variables d'environnement Vercel, jamais exposées au client.
- Blobs privés, URL non énumérable, purge cron quotidienne des audios de plus de 7 jours.
- `DELETE /api/notes/[id]` supprime le blob ; le client supprime segments et transcript
  en local dans la même transaction logique.
- Toutes les routes `/api/*` (hors `auth/login` et le cron) exigent une session valide :
  sans le mot de passe, impossible de consommer le quota du provider de transcription.
- Rate limiting malgré tout sur `/api/transcribe` et `/api/blob/upload-url` : le mot de
  passe peut circuler, un script maladroit ne doit pas vider le quota.
- Mot de passe haché (bcrypt), jamais stocké en clair nulle part ; throttling
  best-effort des tentatives de connexion.
- Page `/confidentialite` : ce qui est envoyé, à qui, où, combien de temps.
