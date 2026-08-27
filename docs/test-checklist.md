# VoxNote — Checklist de test manuel

## iPhone (Safari + Chrome sur iOS)
- [ ] Installer la PWA (Partager → Sur l'écran d'accueil).
- [ ] Autoriser le micro au premier enregistrement.
- [ ] Enregistrer ~30 s → transcription sort → **Copier**.
- [ ] Enregistrer ~5 min (multi-segments) → transcription complète.
- [ ] Pause/reprise pendant l'enregistrement.
- [ ] Écran maintenu pendant l'enregistrement (Wake Lock **non dispo** sur iOS WebKit → bandeau + conseil).
- [ ] Supprimer une note → audio + texte supprimés.
- [ ] Couper le réseau pendant l'upload → **Réessayer** relance.
- [ ] Hors-ligne : notes visibles, transcription = message clair.
- [ ] Confidentialité (pied de page).

## Android (Chrome)
- [ ] Installer la PWA.
- [ ] Enregistrer → transcription → **Copier**.
- [ ] **Wake Lock** : écran reste allumé pendant l'enregistrement.
- [ ] Pause/reprise.

## Windows (Chrome/Edge)
- [ ] Installer la PWA (bureau).
- [ ] Enregistrer → transcription → **Copier**.
- [ ] **Wake Lock** : écran reste allumé.

## Régressions
- [ ] Note longue (10+ min) sans perte.
- [ ] Refus de permission micro → message clair.
- [ ] Note vide (0 s).
- [ ] Double tap sur « Enregistrer » (pas de double démarrage).
