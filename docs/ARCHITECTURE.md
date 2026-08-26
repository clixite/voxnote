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
| Pas de base de données serveur | Local-first, pas d'auth, périmètre v1 | Postgres — inutile sans comptes |
| Upload client direct vers Blob | Limite de body ~4,5 Mo des fonctions serverless | Proxy via route API — casse au-delà de 4,5 Mo |
| Segmentation ~5 min | Borne la perte, contourne la limite de taille par fichier, permet la progression | Fichier unique — tout ou rien |
| IndexedDB avant upload | Un refresh ou un crash ne perd que le segment en cours | État en mémoire — perte totale |
| Interface `TranscriptionProvider` | Bascule UE ↔ US par variable d'environnement, sans refactor | Appel direct au SDK — verrou fournisseur |
| Blob privé + TTL 7 jours | RGPD : minimisation et limitation de conservation | Blob public — URL devinable, fuite |

## Sécurité et RGPD
- Clés API uniquement en variables d'environnement Vercel, jamais exposées au client.
- Blobs privés, URL non énumérable, purge cron quotidienne des audios de plus de 7 jours.
- `DELETE /api/notes/[id]` supprime le blob ; le client supprime segments et transcript
  en local dans la même transaction logique.
- Rate limiting sur `/api/transcribe` et `/api/blob/upload-url` (l'app est publique et
  sans auth : sans limite, n'importe qui peut consommer le quota du provider).
- Page `/confidentialite` : ce qui est envoyé, à qui, où, combien de temps.
