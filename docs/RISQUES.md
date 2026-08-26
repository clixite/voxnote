# Risques — top 5

Classement par impact réel sur la v1, pas par probabilité seule.

## 1. iPhone : l'enregistrement s'arrête quand l'écran se verrouille
**Impact : élevé — c'est la plateforme cible principale et le défaut est visible par l'utilisateur.**
Safari suspend `MediaRecorder` dès que l'app passe en arrière-plan ou que l'écran
se verrouille. Aucune API web ne permet de contourner cela aujourd'hui.

Parade v1 : `navigator.wakeLock.request('screen')` au démarrage de l'enregistrement,
re-demandé au retour au premier plan, plus un bandeau explicite dans l'UI. En prime,
la segmentation limite les dégâts si la suspension survient quand même : seul le
segment en cours est affecté, tout ce qui précède est déjà en IndexedDB.

Si ça reste bloquant à l'usage : v2 en wrap Capacitor, le code React est réutilisé
à ~90 %. C'est une décision produit, pas une correction de bug.

## 2. Perte de données au milieu d'un enregistrement long
**Impact : élevé — perdre 40 min de réunion détruit la confiance dans l'outil.**
Crash de l'onglet, rechargement accidentel, batterie vide, purge de stockage iOS.

Parade : c'est l'architecture entière qui répond. Segments d'environ 5 min, écrits
en IndexedDB **avant** tout upload, file d'upload persistée avec retry. Perte
maximale : le segment en cours. Ce risque est couvert par des tests explicites
(P2-5, P3-7) — enregistrement de 30 min, refresh en cours, coupure réseau. Si ces
tests ne passent pas, la phase ne passe pas.

Risque résiduel : iOS peut purger le stockage d'une PWA installée peu utilisée.
Mitigation : avertir l'utilisateur que les notes non transcrites doivent partir vite.

## 3. Limite de body de 4,5 Mo des fonctions Vercel
**Impact : élevé si découvert tard, nul si respecté dès le départ.**
C'est le piège classique : on code un `POST /api/transcribe` qui reçoit le fichier,
tout marche sur un mémo de 30 s, et ça casse au premier enregistrement de 10 min.

Parade : contrainte inscrite dans `CLAUDE.md`, dans l'agent `dev-backend` et dans
la skill `audio-web` ; upload client direct vers Vercel Blob ; **test dédié** en
P3-3 qui envoie un body volumineux à la route et vérifie qu'elle le refuse. La
règle n'est pas une consigne, elle est vérifiée par la CI.

## 4. RGPD : transfert d'audio hors UE et durée de conservation
**Impact : moyen à élevé selon l'usage réel — faible pour des notes personnelles, sérieux dès qu'un tiers est enregistré.**
Le défaut Groq héberge aux États-Unis. Une note de réunion contient les propos de
personnes qui n'ont rien accepté.

Parade : interface `TranscriptionProvider` avec `gladia` (UE) disponible dès le
premier ticket backend, bascule par variable d'environnement ; blobs privés ; purge
automatique à 7 jours ; suppression d'une note qui efface audio **et** texte ; page
confidentialité explicite sur l'hébergement. Arbitrage demandé au STOP de Phase 0
(cf. `docs/PROVIDER-TRANSCRIPTION.md`).

## 5. L'authentification devient la seule porte : elle doit tenir
**Impact : moyen à élevé — une auth maison bâclée est pire qu'une app ouverte, parce qu'elle donne un faux sentiment de sécurité.**
Depuis l'ajout des comptes (Phase 1bis), tout l'accès repose sur un cookie signé et
un hash de mot de passe écrits pour ce projet. Les erreurs classiques : secret par
défaut committé, rôle vérifié uniquement dans l'UI, énumération de comptes, pas de
throttling sur la connexion, session non révocable.

Parade : `AUTH_SECRET` obligatoire et vérifié au démarrage (aucune valeur par défaut) ;
rôle vérifié côté serveur à chaque requête, jamais seulement en masquant un bouton ;
réponse identique que l'email existe ou non ; throttling des tentatives ;
`token_version` pour révoquer une session sans table à purger ; revue de sécurité
dédiée et bloquante (P1B-9). Le périmètre reste volontairement étroit : pas de
réinitialisation par email, pas d'OAuth — moins de surface, moins de failles.

Effet de bord positif : le risque d'abus de quota disparaît en grande partie. Sans
compte, on ne consomme plus une seconde de transcription. Le rate limiting (P3-1,
P3-3, P5-3) et le plafond de 2 h par note restent en place comme seconde ceinture,
au cas où un compte légitime dérape.

---

## Suivis mineurs (pas dans le top 5)
- **Qualité du néerlandais** : Whisper est moins bon en nl qu'en fr. À vérifier sur
  un échantillon réel en Phase 3 ; si insuffisant, tester `gladia` sur le même échantillon.
- **Tarifs des providers** : ordres de grandeur, à revalider avant de figer le défaut.
- **Dérive de périmètre** : « et si on ajoutait un résumé IA ? » — hors périmètre v1,
  à refuser jusqu'à la livraison de la Phase 6.
- **Malentendu « j'ai un compte, donc mes notes me suivent »** : faux. Les notes
  restent sur l'appareil. À écrire noir sur blanc dans l'UI et le README, sous peine
  d'une mauvaise surprise le jour où l'utilisateur cherche sur son PC une note
  dictée sur son téléphone. La synchronisation est un chantier v2.
- **Dépendance de provisioning** : la base Postgres et le store Blob doivent être
  créés côté Vercel avant que la preview ne soit pleinement fonctionnelle.
