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
| Base de données réduite aux comptes | Imposée par l'auth ; les notes restent locales | Notes en base — chantier v2, hors périmètre |
| Auth maison (cookie signé) plutôt que NextAuth | 2 tables, 1 rôle, ~10 comptes : une dépendance de plus n'apporte rien | NextAuth/Auth.js — dimensionné pour l'OAuth multi-fournisseurs |
| Upload client direct vers Blob | Limite de body ~4,5 Mo des fonctions serverless | Proxy via route API — casse au-delà de 4,5 Mo |
| Segmentation ~5 min | Borne la perte, contourne la limite de taille par fichier, permet la progression | Fichier unique — tout ou rien |
| IndexedDB avant upload | Un refresh ou un crash ne perd que le segment en cours | État en mémoire — perte totale |
| Interface `TranscriptionProvider` | Bascule UE ↔ US par variable d'environnement, sans refactor | Appel direct au SDK — verrou fournisseur |
| Blob privé + TTL 7 jours | RGPD : minimisation et limitation de conservation | Blob public — URL devinable, fuite |

## Authentification et administration

L'application est fermée : aucune page utile, aucune route API n'est accessible sans
session valide. Il n'y a pas d'inscription publique.

```
   visiteur ──▶ middleware ──┬── session valide ? ──▶ page demandée
                             │
                             └── non ──▶ /login
                                          │ POST /api/auth/login (email + mot de passe)
                                          │   └─ argon/bcrypt.compare vs users.password_hash
                                          │   └─ throttling par email + IP (table login_attempts)
                                          ▼
                                  cookie `vox_session` (JWT HS256, jose)
                                  httpOnly · Secure · SameSite=Lax · 30 j
                                  { sub, role, v }   ← `v` = token_version, permet la révocation
```

Rôles : `admin` et `user`. Seul `admin` accède à `/admin` — vérifié **côté serveur à
chaque requête**, jamais seulement en masquant un bouton dans l'UI.

Bootstrap : le tout premier administrateur vient des variables d'environnement
`ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` (un hash, jamais un mot de passe en clair).
Sans lui, personne ne pourrait créer le premier compte. Tous les comptes suivants
sont créés depuis `/admin`.

Révocation : désactiver ou supprimer un compte, ou réinitialiser son mot de passe,
incrémente `token_version`. Les sessions déjà émises deviennent invalides à la
requête suivante, sans table de sessions à purger.

### Modèle de données serveur (Postgres — Neon)

```
users          { id uuid pk, email citext unique, password_hash text,
                 role text check(admin|user), is_active bool,
                 token_version int, must_change_password bool,
                 created_at, last_login_at }

login_attempts { id, email, ip, at, success }   -- throttling, purgé à 24 h
```

C'est tout. Aucune note, aucun transcript, aucun audio en base : les notes restent
en IndexedDB sur l'appareil, l'audio reste dans Blob avec un TTL de 7 jours.

Tests : le store utilisateurs est requêté en SQL simple derrière un module unique,
et les tests tournent sur une base Postgres en mémoire — aucun service externe
n'est requis pour que la CI passe.

## Sécurité et RGPD
- Clés API uniquement en variables d'environnement Vercel, jamais exposées au client.
- Blobs privés, URL non énumérable, purge cron quotidienne des audios de plus de 7 jours.
- `DELETE /api/notes/[id]` supprime le blob ; le client supprime segments et transcript
  en local dans la même transaction logique.
- Toutes les routes `/api/*` (hors `auth/login`) exigent une session valide : sans
  compte, impossible de consommer le quota du provider de transcription.
- Rate limiting malgré tout sur `/api/transcribe` et `/api/blob/upload-url` : un compte
  légitime compromis ou un script maladroit ne doit pas vider le quota.
- Mots de passe hachés (jamais chiffrés, jamais stockés en clair) ; throttling des
  tentatives de connexion ; messages de connexion volontairement identiques que l'email
  existe ou non.
- Page `/confidentialite` : ce qui est envoyé, à qui, où, combien de temps.
