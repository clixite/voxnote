# PRD VoxNote — v1

## Le problème
Prendre une note vocale est instantané ; la relire ne l'est pas. Les mémos du
téléphone finissent non écoutés. Les outils type PLAUD imposent un matériel, un
compte et un abonnement pour une fonction qui tient en trois gestes : enregistrer,
transcrire, coller le texte ailleurs.

## La proposition
Une web app installable (PWA) qui fait trois choses, très bien :
1. **Enregistrer** — un bouton, pause/reprise, compteur, VU-mètre.
2. **Transcrire** — via API serveur (fr, nl, en, détection auto).
3. **Restituer** — liste de notes, transcript éditable, Copier, Partager, export .txt/.md.

Pas d'installation de store, pas d'appareil dédié. On ouvre l'URL, on l'installe
sur l'écran d'accueil, ça marche sur Windows, iPhone et Android.

L'accès est réservé : l'app est protégée par un **mot de passe unique partagé**.
Pas de comptes, pas d'inscription, pas de base de données — un mot de passe, connu
de ceux qui doivent entrer, saisi une fois puis mémorisé pendant 30 jours.

## Utilisateur cible
Le commanditaire et son cercle proche — les quelques personnes à qui il donne le
mot de passe. Usage typique :
mémo de 30 secondes à 30 minutes, dicté en marchant ou après une réunion, dont
le texte part ensuite dans un mail, un document ou un outil de notes.
Multilingue fr / nl / en (contexte belge).

## Cas d'usage numéro 1
Enregistrer → attendre la transcription → **appuyer sur Copier** → coller ailleurs.
Tout le reste est secondaire. Le bouton Copier est visible sans scroll.

## Périmètre v1
Dans le périmètre :
- Enregistrement segmenté (~5 min/segment), pause/reprise, wake lock, VU-mètre, compteur.
- Persistance IndexedDB de chaque segment avant upload ; queue d'upload avec retry.
- Transcription par segment avec progression visible ; assemblage ordonné.
- Liste de notes (titre auto : date + premiers mots), transcript éditable et persisté.
- Copier, Partager (Web Share API, fallback Clipboard + mailto), export .txt et .md.
- Suppression d'une note = suppression audio + texte. Purge auto des audios > 7 jours.
- Page confidentialité. Interface en français.
- Mode offline : notes déjà transcrites consultables, message clair sinon.
- Accès protégé : écran de saisie du mot de passe, session mémorisée 30 jours,
  déconnexion. Le mot de passe se change en modifiant une variable d'environnement.

Hors périmètre v1, à refuser explicitement :
comptes utilisateurs individuels, inscription, page d'administration, base de données,
réinitialisation de mot de passe par email, OAuth, double authentification,
synchronisation des notes entre appareils, résumés IA, diarisation des locuteurs, traduction,
application native, partage collaboratif, recherche full-text avancée, tags.

**Précision importante sur le mot de passe :** il protège l'accès à l'application,
il ne rend pas les notes multi-appareils et n'identifie personne. Les notes restent
stockées localement, dans le navigateur de l'appareil qui les a enregistrées. Deux
appareils qui connaissent le même mot de passe ne voient pas les mêmes notes. La
synchronisation serveur est un chantier v2 (base de données, chiffrement, conflits)
délibérément exclu.

Conséquence assumée : on ne sait pas *qui* est entré, seulement que quelqu'un
connaissait le mot de passe. C'est suffisant pour l'usage visé — empêcher un
inconnu d'utiliser l'app et de consommer le quota de transcription.

## Non-négociables produit
- Zéro perte de données sur refresh, crash ou coupure réseau (au pire le segment en cours).
- Aucun secret côté client ; l'audio ne transite jamais par une route API.
- Messages d'erreur en français, compréhensibles par un non-technicien.
- Plafond de durée par note : 2 h (garde-fou coût, cf. `docs/RISQUES.md`).

## Ce qui définit le succès de la v1
1. Un mémo de 10 minutes enregistré sur iPhone est lisible en texte, copiable, en moins
   d'une minute après la fin de l'enregistrement.
2. Un refresh accidentel en cours d'enregistrement ne perd rien de ce qui est déjà enregistré.
3. L'app est installée sur l'écran d'accueil des trois plateformes cibles et s'ouvre
   sans barre d'adresse.
4. Un visiteur sans le mot de passe ne peut ni voir l'app, ni consommer une seule
   seconde de transcription.
5. Lighthouse : PWA installable, performance > 90 sur mobile.

## Limite assumée et communiquée
Sur iPhone, aucune web app ne peut enregistrer écran verrouillé. La v1 maintient
l'écran allumé (wake lock) et affiche un bandeau explicite. Si c'est bloquant à
l'usage, la v2 est un wrap Capacitor réutilisant le code React.
