---
name: audio-web
description: Pièges de la capture audio web cross-platform (Safari iOS, Chrome Android, desktop). À lire avant tout code touchant à MediaRecorder, getUserMedia, PWA ou upload audio.
---

# Capture audio web : les pièges connus

## Safari iOS (le vrai sujet)
- MediaRecorder produit **audio/mp4 (AAC)**. Chrome/Edge/Firefox produisent
  **audio/webm (Opus)**. Toujours détecter via `MediaRecorder.isTypeSupported`
  et stocker le mimeType avec le blob.
  Ordre de détection conseillé :
  ~~~ts
  const CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const mimeType = CANDIDATES.find(t => MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('Enregistrement non supporté par ce navigateur');
  ~~~
- MediaRecorder est dispo à partir d'**iOS 14.3** (et Safari 14.1 desktop).
- getUserMedia exige **HTTPS** et un **geste utilisateur** (tap). Jamais d'auto-start.
- L'enregistrement s'arrête si l'écran se verrouille ou si Safari passe en
  arrière-plan. **L'API Wake Lock n'est PAS supportée par Safari iOS** (elle ne
  marche que sur Chrome/Edge, donc Android/desktop). Sur iPhone, seule parade v1 :
  bandeau d'avertissement « garde l'écran allumé pendant l'enregistrement » +
  conseil de régler le verrouillage auto. Pas de vraie solution web à ce jour.
- L'AudioContext démarre parfois en état `suspended` : reprendre avec
  `resume()` sur geste utilisateur.
- PWA installée : **Safari peut purger IndexedDB d'un site non visité depuis
  7 jours**. Prévenir l'utilisateur que les notes non transcrites doivent être
  envoyées rapidement → upload immédiat après l'enregistrement.

## Stratégie d'enregistrement robuste (toutes plateformes)
- MediaRecorder avec `timeslice` : découper en segments d'environ 5 minutes.
- Chaque segment est **immédiatement persisté en IndexedDB** PUIS uploadé
  (queue avec retry). Un crash/refresh ne perd au pire que le segment en cours.
- Enregistrer l'ordre des segments (`index`) : c'est lui qui pilote l'assemblage.
- Upload : client direct vers Vercel Blob (jamais via une route API : limite
  body ~4,5 Mo des fonctions serverless).
- **Wake lock** : `navigator.wakeLock?.request('screen')` uniquement quand
  l'API existe (Android/desktop) ; ne rien promettre sur iOS.

## Transcription
- Whisper via API a une limite de ~25 Mo/fichier (OpenAI). Un segment ~5 min
  (AAC/Opus ≈ 1,5–4 Mo) reste largement sous la limite → le découpage règle le
  problème nativement.
- Assembler les segments **dans l'ordre de `index`**, avec horodatage.
- Traitement **par segment** côté serveur (une invocation par segment) : ne
  jamais faire transiter un long fichier en une seule fonction serverless.

## Partage du texte
- `navigator.share` (Web Share API) sur mobile, fallback : Clipboard API + `mailto:`.
- Toujours un bouton Copier visible : c'est le cas d'usage n° 1.

## Checklist de vérification (à cocher en revue)
- [ ] mimeType détecté à l'exécution, jamais de user-agent sniffing.
- [ ] segments persistés en IndexedDB AVANT upload.
- [ ] queue d'upload avec retry (coupure réseau).
- [ ] wake lock seulement si l'API existe + bandeau d'avertissement.
- [ ] suppression d'une note = blob + transcript + IndexedDB.
