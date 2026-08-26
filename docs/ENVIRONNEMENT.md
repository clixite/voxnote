# Variables d'environnement — VoxNote

Tous les secrets sont configurés dans **Vercel** (ou en local dans `.env.local` si vous testez en développement). Aucun secret n'est commité, ni par défaut en code.

## Tableau des variables

| Variable | Obligatoire | Où l'obtenir | Rôle | Si absente |
|---|---|---|---|---|
| **AUTH_SECRET** | Oui | Générez une clé aléatoire (ex. `openssl rand -base64 32`) | Signe les cookies JWT de session pour authentifier l'accès | Échec au démarrage — l'app refuse de démarrer |
| **APP_PASSWORD_HASH** | Oui | Générez avec `pnpm hash-password` | Hash bcrypt du mot de passe unique d'accès | Échec au démarrage — l'app refuse de démarrer |
| **TRANSCRIBE_PROVIDER** | Non | Valeurs autorisées : `groq` (défaut), `openai`, `gladia` | Choisit le fournisseur de transcription (IA) | Défaut à `groq` |
| **GROQ_API_KEY** | Si `TRANSCRIBE_PROVIDER=groq` | Console [Groq](https://console.groq.com) → API Keys | Clé API pour transcription Groq | Erreur lors d'une transcription avec Groq |
| **OPENAI_API_KEY** | Si `TRANSCRIBE_PROVIDER=openai` | Dashboard [OpenAI](https://platform.openai.com/api-keys) | Clé API pour transcription OpenAI Whisper | Erreur lors d'une transcription avec OpenAI |
| **GLADIA_API_KEY** | Si `TRANSCRIBE_PROVIDER=gladia` | Tableau de bord [Gladia](https://app.gladia.io) → API Keys | Clé API pour transcription Gladia (conforme RGPD UE) | Erreur lors d'une transcription avec Gladia |
| **BLOB_READ_WRITE_TOKEN** | Oui | Vercel → Projet → Storage → Create → Blob → Token de lecture/écriture | Accès en lecture/écriture aux fichiers audio stockés en Blob | Impossible de charger ou télécharger un fichier audio |
| **CRON_SECRET** | Oui | Générez une clé aléatoire (ex. `openssl rand -base64 32`) | Sécurise la route cron de purge (`/api/cron/purge`) | Les tâches cron refusées ; les anciens audios ne sont pas purgés |

## Authentification (mot de passe unique)

### Génération du hash au démarrage

1. Choisissez votre **phrase de passe** (ex. `Mon enregistrement vocal privé 2025`)
2. Générez le hash localement avec :
   ```bash
   pnpm hash-password
   ```
3. Copiez la valeur affichée dans le champ `APP_PASSWORD_HASH` dans les variables Vercel
4. Redéployez : `vercel deploy --prod`

### Changer le mot de passe

Changement du mot de passe = redéploiement. Procédure :

1. Générez un nouveau hash localement : `pnpm hash-password`
2. Mettez à jour `APP_PASSWORD_HASH` dans **Vercel Dashboard** → Settings → Environment Variables
3. Redéployez (déploiement manuel ou via git push)
4. **Effet** : tous les cookies de session existants deviennent invalides ; utilisateurs doivent se reconnecter

Aucune table de sessions à gérer — c'est la "révocation du pauvre", suffisante pour un cercle de confiance.

### Jeu d'essai pour les tests (CI et Playwright)

`playwright.config.ts` (bloc `webServer.env`) et `.github/workflows/ci.yml` (les deux jobs)
committent des valeurs de test **publiques**, volontairement fictives — ce ne sont pas des
secrets, elles n'ont aucune valeur en production :

| Variable | Valeur de test | Remarque |
|---|---|---|
| Mot de passe en clair | `phrase-de-passe-de-test-voxnote` | Utilisé par les e2e de connexion |
| `APP_PASSWORD_HASH` | hash bcrypt réel de la phrase ci-dessus | Généré avec `pnpm hash-password` |
| `AUTH_SECRET` | `voxnote-public-ci-test-secret-do-not-use-in-prod` | 48 caractères, manifestement factice |

Ces valeurs ne doivent jamais être réutilisées pour un déploiement réel.

## Configuration par fournisseur de transcription

### Groq (défaut, recommandé)

```
TRANSCRIBE_PROVIDER=groq
GROQ_API_KEY=gsk_xxxxxxxxxxxx
```

- Gratuit jusqu'à un certain quota
- Modèle : Whisper
- Langues : français, néerlandais, anglais (auto-détecté)

### OpenAI Whisper

```
TRANSCRIBE_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxxxxxxxxx
```

- Facturation à l'utilisation (par minute d'audio)
- Modèle : Whisper (même que Groq, mais via OpenAI)

### Gladia (UE, conforme RGPD)

```
TRANSCRIBE_PROVIDER=gladia
GLADIA_API_KEY=xxxxxxxxxxxx
```

- Serveurs en UE
- Modèles propriétaires
- Facturation à l'utilisation

## Déploiement sur Vercel

Toutes les variables **SAUF** `TRANSCRIBE_PROVIDER` doivent être définis comme **Secrets** (pas Production-only, à moins que vous ne vouliez pas tester en staging).

1. Vercel Dashboard → Projet → Settings → Environment Variables
2. Ajoutez chaque variable
3. Redéployez : `git push` ou `vercel deploy --prod`

## Développement local

Pour tester en local, créez un fichier `.env.local` à la racine du projet (ignoré par git) :

```bash
cp .env.example .env.local
```

Puis remplissez les valeurs réelles. L'app chargera d'abord `.env.local`, ensuite les variables d'environnement du système.

## Sécurité

- **Aucun secret côté client** : tous les secrets sont résolus côté serveur
- **Aucune clé API dans le code** : exclusivement en variables d'environnement
- **Aucun secret par défaut** : absence de `AUTH_SECRET` ou `APP_PASSWORD_HASH` = **échec au démarrage**
- **Pas de fichier .env commité** : `.env.local` est ignoré ; seul `.env.example` est versionné

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Erreur "AUTH_SECRET is required" au démarrage | `AUTH_SECRET` absent ou vide | Générez une clé aléatoire et définissez-la dans Vercel |
| Erreur "APP_PASSWORD_HASH is required" au démarrage | `APP_PASSWORD_HASH` absent ou vide | Générez un hash avec `pnpm hash-password` et mettez-le dans Vercel |
| Impossible de se connecter avec le bon mot de passe | Hash incorrect ou `APP_PASSWORD_HASH` non déployé | Vérifiez le hash local, regénérez-le au besoin, redéployez |
| Transcription échoue : "API key invalid" | Clé API du fournisseur invalide ou expirée | Vérifiez la clé dans la console du fournisseur (Groq, OpenAI, Gladia) |
| Impossible de sauvegarder les audios | `BLOB_READ_WRITE_TOKEN` absent ou révoqué | Générez un nouveau token dans Vercel Blob |
| Audios anciens ne sont pas supprimés | `CRON_SECRET` absent | Définissez une clé aléatoire dans `CRON_SECRET`, redéployez |
