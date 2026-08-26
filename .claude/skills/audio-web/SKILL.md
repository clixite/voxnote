---
name: audio-web
description: Pièges de la capture audio web cross-platform (Safari iOS, Chrome Android, desktop). À lire avant tout code touchant à MediaRecorder, getUserMedia, PWA ou upload audio.
---

# Capture audio web : les pièges connus

## Safari iOS (le vrai sujet)
- MediaRecorder produit audio/mp4 (AAC). Chrome/Edge/Firefox produisent audio/webm (Opus).
  Toujours détecter via MediaRecorder.isTypeSupported et stocker le mimeType avec le blob.
- getUserMedia exige HTTPS et un geste utilisateur (tap). Jamais d'auto-start.
- L'enregistrement s'arrête si l'écran se verrouille ou si Safari passe en arrière-plan.
  Parade v1 : navigator.wakeLock.request('screen') + bandeau d'avertissement utilisateur
  "garde l'écran allumé pendant l'enregistrement". Pas de vraie solution web à ce jour.
- L'AudioContext démarre parfois en état suspended : reprendre avec resume() sur geste utilisateur.
- PWA installée : le stockage peut être purgé par iOS si l'app n'est pas utilisée. Prévenir
  l'utilisateur que les notes non transcrites doivent être envoyées rapidement.

## Stratégie d'enregistrement robuste (toutes plateformes)
- MediaRecorder avec timeslice : découper en segments d'environ 5 minutes.
- Chaque segment est immédiatement persisté en IndexedDB puis uploadé (queue avec retry).
  Un crash ou un refresh ne perd au pire que le segment en cours.
- Upload : client direct vers Vercel Blob (jamais via une route API, limite de body).

## Transcription
- Whisper via API a une limite de taille par fichier (environ 25 Mo chez OpenAI) :
  le découpage en segments de 5 min règle le problème nativement.
- Assembler les segments dans l'ordre, avec horodatage.

## Partage du texte
- navigator.share (Web Share API) sur mobile, fallback : Clipboard API + mailto.
- Toujours un bouton Copier visible : c'est le cas d'usage numéro 1.
