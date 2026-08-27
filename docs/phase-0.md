# VoxNote — Phase 0 : Cadrage

> Livrable de cadrage, avant tout code. Validation requise avant de lancer la Phase 1.

## 1. PRD (une page)

### Vision
Capturer une idée vocale et la transformer en texte exploitable en 2 gestes : « enregistrer », puis « copier / envoyer ». Une PWA type PLAUD.AI, sans compte, sans friction.

### Cible
Utilisateurs francophones (FR/BE) qui prennent des notes vocales sur mobile (iPhone Safari, Android Chrome) et récupèrent le texte sur desktop (Windows).

### Périmètre v1 — 3 fonctions, très bien faites
1. **Enregistrer** : bouton unique, pause/reprise, compteur, VU-mètre simple.
2. **Transcrire** : API serveur, fr / nl / en, détection auto.
3. **Restituer** : liste de notes, transcript éditable, Copier, Partager (Web Share + fallback mailto), export .txt / .md.

### Hors périmètre (refus de toute dérive)
Comptes / auth, résumés IA, diarisation, traduction, app native. **Local-first, pas d'auth.**

### Parcours utilisateur
1. Ouvrir l'app (installée) → tap sur le bouton record → enregistrement démarre.
2. Pendant : VU-mètre + compteur + pause/reprise + bandeau « garde l'écran allumé ».
3. Stop → la note passe en « transcription » avec progression par segment.
4. Transcript prêt → éditer si besoin → Copier (cas n°1) ou Partager / exporter.
5. Notes consultables hors-ligne ; suppression = effacement complet (audio + texte).

### Critères de succès (mesurables)
- 0 perte de données sur refresh / coupure réseau pendant l'enregistrement.
- Transcrire 10 min d'audio < 60 s (Groq), progression visible.
- Copier 10 000 mots sans perte.
- Lighthouse PWA installable + perf > 90 (mobile).
- Zéro secret côté client ; zéro audio transitant par une route API.

## 2. Architecture

> Note : la décision §7 (Capacitor v1) fait du frontend une **SPA Vite + React** chargée dans un shell Capacitor, la PWA restant la cible desktop/web. Le schéma ci-dessous représente le cœur (web + API) ; l'enregistrement iOS/Android passe par @mozartec/capacitor-microphone (foreground, gratuit).

~~~text
┌────────────────────────────────────────────────┐
│  CLIENT — PWA Next.js (React + TS strict)      │
│                                                │
│  useRecorder (mimeType + timeslice ~5 min)     │
│      │                                         │
│      ▼                                         │
│  IndexedDB (idb) — segments AVANT upload       │
│  queue d'upload (retry)                        │
│      │                                         │
└──────┼─────────────────────────────────────────┘
       │ ① upload client DIRECT (signed URL / client token)
       ▼
  ┌───────────────────┐
  │  Vercel Blob      │   audio/mp4 (Safari) · audio/webm (Chrome)
  └─────────┬─────────┘   (jamais via une route API)
            │ ② la route reçoit seulement URL + mimeType + index
            ▼
  ┌──────────────────────────────────────────────────┐
  │  API Next.js (route handlers, Vercel serverless) │
  │  POST   /api/notes                 create        │
  │  POST   /api/notes/:id/transcribe  ──► TranscriptionProvider
  │  GET    /api/notes/:id              status       │    ├─ groq (défaut)
  │  PATCH  /api/notes/:id              edit         │    ├─ openai
  │  DELETE /api/notes/:id              purge        │    └─ gladia (UE)
  │  GET    /api/cron/purge             orphelins    │
  └──────────────┬────────────────────────────────────┘
                 │ ③ transcript par segment (une invocation = un segment)
                 ▼
  ┌────────────────────────────────┐
  │  Vercel Postgres (Neon)        │  notes + segments + statuts + transcript
  └────────────────────────────────┘
~~~

### Décisions structurantes
- **Audio = Vercel Blob** (upload client direct). **Notes / statuts = Vercel Postgres (Neon)** : le statut par segment (`queued → transcribing → done`) et l'assemblage ordonné exigent un état durable et requêtable ; Neon serverless s'intègre nativement à Vercel.
- **Local-first, pas d'auth** : l'identité d'une note = UUID généré côté client, non devinable. Le serveur stocke par UUID. Liste + transcript sont aussi en IndexedDB côté client (source de vérité pour l'affichage offline).
- **Transcription par segment** : une invocation serverless par segment (pas de timeout dépassé, retry naturel). L'assemblage se fait quand tous les segments sont `done`.

## 3. Choix du provider de transcription

| Critère | Groq whisper-large-v3-turbo | OpenAI whisper-1 | Gladia |
|---|---|---|---|
| Coût / h audio | **~0,04 $** (le moins cher) | 0,006 $/min ≈ 0,36 $/h (~9×) | plus élevé, à confirmer |
| Latence | très basse (segments courts < 1 s) | correcte | correcte |
| Langues | auto + 99 (fr/nl/en OK) | auto + fr/nl/en OK | 100+ (fr/nl/en OK) |
| Limite / fichier | pas bloquant (segments) | **25 Mo** | pas bloquant (segments) |
| RGPD / hébergement | US — option zero retention | US — pas d'entraînement par défaut | **France, hébergé UE, RGPD natif** |
| Variable | `GROQ_API_KEY` | `OPENAI_API_KEY` | `GLADIA_API_KEY` |

### Recommandation
- **Défaut : Groq whisper-large-v3-turbo** — meilleur rapport coût/latence (~0,04 $/h ; une note de 10 min ≈ 0,007 $). Le découpage en segments neutralise la limite de taille.
- **Bascule RGPD : Gladia** si l'exigence impose un hébergement UE strict (société française, RGPD natif). Le switch est trivial via `TRANSCRIBE_PROVIDER` + l'interface `TranscriptionProvider`.
- **OpenAI** conservé en repli (coût plus élevé, limite 25 Mo, mais très fiable).
- ⚠️ Chiffres indicatifs : re-vérifier les tarifs au moment de l'implémentation (règle « vérifie via web_search »).

## 4. Contrat d'API (figé)

### Types partagés (lib/types.ts)
~~~ts
export type SegmentStatus = 'queued'|'uploading'|'transcribing'|'done'|'failed';
export type NoteStatus = 'recording'|'queued'|'processing'|'done'|'error'|'deleted';
export type Lang = 'fr'|'nl'|'en'|'auto';

export interface AudioSegment {
  id: string; noteId: string; index: number;      // ordre de montage
  blobUrl?: string; mimeType: string;             // audio/mp4 | audio/webm
  durationMs: number; status: SegmentStatus;
  transcript?: string; error?: string;
}
export interface Note {
  id: string; title: string; lang: Lang;
  segments: AudioSegment[]; transcript: string;   // assemblage ordonné
  status: NoteStatus;
  createdAt: number; updatedAt: number;
}
~~~

### Routes
| Méthode | Chemin | Entrée | Sortie | Erreurs |
|---|---|---|---|---|
| POST | /api/notes | — | { id } | 400 / 429 |
| POST | /api/notes/:id/transcribe | { segments:[{blobUrl,mimeType,index}] } | { status } | 400 / 404 / 429 / 502 |
| GET | /api/notes/:id | — | Note (statut + segments) | 404 |
| PATCH | /api/notes/:id | { transcript } | { ok } | 400 / 404 |
| DELETE | /api/notes/:id | — | { ok } | 404 |
| GET | /api/cron/purge | header `Authorization: Bearer $CRON_SECRET` | { purged } | 401 |

### Validation & garde-fous
- mimeType whitelist : `audio/mp4`, `audio/webm`, `audio/mpeg`, `audio/wav`, `audio/ogg` (sinon 400).
- Taille segment max 25 Mo ; durée note max 2 h ; nb segments max 24 (2 h / 5 min).
- Rate limiting (~10 req/min/IP) sur `/transcribe` et `/notes`.
- Retry exponentiel 3 tentatives côté provider ; erreur traduite en message FR exploitable.
- Idempotence : un `index` de segment déjà `done` n'est jamais re-transcrit.

## 5. Backlog (tickets + critères d'acceptation)

### Phase 1 — Socle
- **T-01 Scaffold** — Next.js App Router + TS strict + Tailwind + ESLint/Prettier. AC : `tsc -b` vert ; `lint` vert ; page d'accueil servie.
- **T-02 PWA installable** — @serwist/next : manifest, icônes, service worker. AC : manifest valide ; install desktop OK ; accueil chargé hors-ligne.
- **T-03 CI** — GitHub Actions lint + typecheck + test + build. AC : pipeline verte ; échoue sur type error.
- **T-04 Vercel + Blob** — projet, env vars (.env.example), Blob store, preview. AC : preview accessible ; env vars documentées ; Blob store créé.

### Phase 2 — Capture audio
- **T-05 useRecorder** — mimeType à l'exécution, timeslice ~5 min, pause/reprise, compteur. AC : pas de UA sniffing ; segments ~5 min ; pause/reprise OK.
- **T-06 Persistance IndexedDB** — segments persistés AVANT upload + reprise après refresh. AC : refresh = 0 perte ; queue reprise au reload.
- **T-07 Wake lock + bandeau + VU-mètre** — `navigator.wakeLock` si dispo + bandeau + VU-mètre. AC : bandeau visible ; VU réagit ; wake lock si API dispo.
- **T-08 E2E capture** — fake media streams : permission refusée, refresh, 30 min simulées. AC : 3 projets Playwright verts.

### Phase 3 — Pipeline de transcription
- **T-09 Upload direct Blob + queue retry** — client token, upload segments, reprise coupure réseau. AC : reprise après coupure ; 0 perte ; audio jamais via API.
- **T-10 TranscriptionProvider** — interface + impl groq (défaut) + `TRANSCRIBE_PROVIDER`. AC : switch par env var ; test unit par provider (mocké).
- **T-11 Routes API** — create/transcribe/status/patch/delete + validation + rate limit. AC : test d'intégration par route ; mimeType/taille → 400 ; > 10 req/min → 429.
- **T-12 Assemblage + erreurs** — ordonné par index, horodatage, retry 3×, messages FR. AC : 10 min → ordonné sans chevauchement ; erreur provider → message clair.
- **T-13 Suppression + cron purge** — DELETE efface blob(s) + texte ; cron purge orphelins > 7 j. AC : suppression vérifiée ; cron protégé CRON_SECRET.

### Phase 4 — Restitution
- **T-14 Liste + éditeur** — titre auto (date + 1ers mots), transcript éditable, édition persistée. AC : titre correct ; édition persistée après reload.
- **T-15 Copier / Partager / export** — Copier, Web Share + fallback mailto, export .txt/.md. AC : copier 10 000 mots sans perte ; partage e2e mobile ; exports corrects.

### Phase 5 — Durcissement
- **T-16 Offline** — notes consultables hors-ligne ; message clair si transcription impossible. AC : liste + transcripts lisibles sans réseau ; action → message explicite.
- **T-17 Sécurité + RGPD** — revue architecte-reviewer + page /confidentialite. AC : zéro BLOQUANT ; page confidentialité publiée.
- **T-18 Lighthouse** — PWA installable + perf mobile > 90. AC : rapport fourni ; installable ; perf > 90.

### Phase 6 — Prod
- **T-19 Deploy prod + README** — deploy prod, env vars prod, README complet. AC : URL de prod ; README (install, env vars, déploiement, limites).
- **T-20 Checklist manuelle** — checklist iPhone Safari + Android Chrome (micro, verrouillage, install, partage). AC : checklist rédigée, à exécuter soi-même.

## 6. Risques top 5

1. **Enregistrement iPhone écran verrouillé** (accepté comme limitation v1) — aucune solution gratuite ne le permet. Mitigation : wake lock (Android/desktop) + bandeau (iOS) ; v2 = Capawesome payant ou plugin custom.
2. **Dépassement de coût transcription** (prob. moyenne, impact moyen) — plafonds 2 h/note + 20 h/mois + alerte + rate limiting.
3. **Compatibilité PWA / App Router** (prob. moyenne, impact moyen) — next-pwa non maintenu → @serwist/next, vérifié via web_search, test install dès T-02.
4. **Éviction IndexedDB iOS (7 j sans visite)** (prob. moyenne, impact fort) — upload immédiat après enregistrement + message utilisateur.
5. **RGPD / transfert hors UE (provider US)** (prob. faible→moyenne, impact juridique) — interface provider + bascule Gladia (UE) ; zero retention côté Groq ; page confidentialité ; suppression complète.

---

## 7. Décision produit (révisée)

**v1 = app hybride Capacitor** (iOS + Android) + PWA desktop/web.

- **Enregistrement** : plugin gratuit **@mozartec/capacitor-microphone** (iOS/Android, AAC .m4a, foreground) + repli MediaRecorder sur web. **Écran verrouillé abandonné en v1** : le seul plugin qui le supporte (Capawesome) est payant, aucun plugin gratuit/maintenu ne le couvre (vérifié).
- **Mitigation arrière-plan** : wake lock (Android/desktop) + bandeau « garde l'écran allumé » (iOS).
- **v2 (si besoin)** : Capawesome (payant) ou mini-plugin custom (Swift AVAudioRecorder + UIBackgroundModes: audio).
- **Conséquence stack frontend** : le shell Capacitor charge un build statique → le frontend devient une **SPA Vite + React + TS + Tailwind** (une seule base pour PWA + Capacitor). L'API reste **Next.js (route handlers)** sur Vercel, inchangée.
- **Implications** : compte Apple Developer ($99/an) + soumission App Store ; tests sur **vrais appareils** (le verrouillage / arrière-plan ne se simule pas en Playwright) ; Playwright reste pour l'UI / la transcription web.
- **Nouveau risque** : développement natif (plugin, provisioning, signatures) — mitigé par un plugin éprouvé + un build CI dédié.

---

**STOP — validation requise avant Phase 1 (révisée).**
