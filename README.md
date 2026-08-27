# VoxNote

PWA + app Capacitor d'enregistrement vocal et transcription (type PLAUD.AI simplifié).

## Fonctionnalités
- Enregistrement audio (segments ~1 min), pause/reprise, VU-mètre, écran maintenu (Wake Lock + fallback vidéo).
- Transcription Groq (whisper-large-v3-turbo), audio converti en WAV 16 kHz, **suppression de l'audio après transcription** (RGPD).
- Notes en local (IndexedDB), titre auto, durée, copier, consultable hors-ligne.
- PWA installable (Windows, Android, iPhone).

## Stack
- Monorepo pnpm : `apps/web` (Vite + React + Tailwind + vite-plugin-pwa), `apps/api` (Next.js route handlers), `packages/shared` (types).
- Stockage : IndexedDB (client) + **Vercel Blob** (audio, privé).
- Transcription : Groq (défaut), bascule Gladia/OpenAI via `TRANSCRIBE_PROVIDER`.

## Démarrage
~~~bash
pnpm install
pnpm dev:web   # http://localhost:5173
pnpm dev:api   # http://localhost:3000
~~~

## Variables d'environnement (apps/api, côté Vercel)
- `GROQ_API_KEY` — clé Groq (transcription).
- `BLOB_STORE_ID` + `BLOB_WEBHOOK_PUBLIC_KEY` — auto-ajoutées via « Connect to Project » du store Blob.
- `TRANSCRIBE_PROVIDER` — `groq` (défaut) | `gladia` | `openai`.
- `CRON_SECRET` — protection du cron de purge.

## Déploiement
Projets Vercel : `voxnote-web` (Vite, rootDirectory `apps/web`) et `voxnote-api` (Next.js, rootDirectory `apps/api`).

## Limites
- **iPhone (WebKit)** : pas de Wake Lock → l'enregistrement écran verrouillé n'est pas garanti en web (v2 = app Capacitor native).
- Pas de diarisation en v1 (à venir via Gladia).
