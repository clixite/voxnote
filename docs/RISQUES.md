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

## 5. Le mot de passe unique devient la seule porte
**Impact : moyen — une porte mal posée est pire qu'une porte absente, parce qu'elle rassure à tort.**
Depuis la Phase 1bis, tout l'accès repose sur un hash en variable d'environnement et
un cookie signé. Les façons de rater ça sont connues : secret par défaut committé,
cookie signé avec une valeur devinable, mot de passe court soumis au bruteforce,
route oubliée hors du middleware, hash renvoyé au client par mégarde.

Parade : `AUTH_SECRET` et `APP_PASSWORD_HASH` obligatoires et vérifiés au démarrage,
sans valeur de repli ; cookie httpOnly + Secure + SameSite ; test qui parcourt toutes
les routes `/api/*` sans cookie et exige un 401 ; empreinte du hash dans le JWT pour
que changer le mot de passe déconnecte tout le monde ; revue de sécurité dédiée et
bloquante (P1B-5). Le périmètre reste volontairement minuscule : pas de comptes, pas
d'emails, pas d'OAuth — presque aucune surface d'attaque.

Deux limites à assumer plutôt qu'à cacher :
- **Le throttling est best-effort.** Un compteur en mémoire ne survit pas à un cold
  start et ne se partage pas entre instances serverless. Le vrai frein est la lenteur
  de bcrypt, qui ne protège que si le mot de passe est long. **Consigne : une phrase
  de passe de plusieurs mots, pas un mot de huit lettres.**
- **On ne révoque pas individuellement.** Changer le mot de passe le change pour tout
  le monde, et on ne sait pas qui s'est connecté. C'est le prix du « pas de base de
  données ». Le jour où il faut retirer l'accès à une seule personne, il faut de vrais
  comptes, donc une base : c'est une décision v2, pas une rustine.

Effet de bord positif : le risque d'abus de quota disparaît en grande partie. Sans le
mot de passe, on ne consomme plus une seconde de transcription. Le rate limiting
(P3-1, P3-3, P5-3) et le plafond de 2 h par note restent comme seconde ceinture.

---

## Suivis mineurs (pas dans le top 5)
- **Qualité du néerlandais** : Whisper est moins bon en nl qu'en fr. À vérifier sur
  un échantillon réel en Phase 3 ; si insuffisant, tester `gladia` sur le même échantillon.
- **Tarifs des providers** : ordres de grandeur, à revalider avant de figer le défaut.
- **Dérive de périmètre** : « et si on ajoutait un résumé IA ? » — hors périmètre v1,
  à refuser jusqu'à la livraison de la Phase 6.
- **Malentendu « je me connecte, donc mes notes me suivent »** : faux. Les notes
  restent sur l'appareil. À écrire noir sur blanc dans l'UI et le README, sous peine
  d'une mauvaise surprise le jour où l'utilisateur cherche sur son PC une note
  dictée sur son téléphone. La synchronisation est un chantier v2.
- **Dépendance de provisioning** : le store Blob et les variables d'environnement
  doivent être créés côté Vercel avant que la preview ne soit pleinement fonctionnelle.
