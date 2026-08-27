# VoxNote — App native iOS (Capacitor)

Objectif : enregistrer **écran verrouillé / en arrière-plan** sur iPhone (impossible en web à cause de WebKit). Le code React est réutilisé (~90 %).

## Prérequis
- **macOS** + **Xcode** (la compilation iOS se fait uniquement sur Mac).
- Compte **Apple Developer** ($99/an) pour l'installation sur appareil / l'App Store.

## Config déjà en place
- `ios/App/App/Info.plist` : **`UIBackgroundModes: [audio]`** ✅ (permet de continuer à enregistrer l'audio en arrière-plan).
- Plugin **@mozartec/capacitor-microphone** (enregistrement native, AAC .m4a) installé + sync.
- `webDir: dist`, `appId: com.voxnote.app`.

> Pour un enregistrement arrière-plan **fiable**, le plugin doit configurer l'AVAudioSession en catégorie `.playAndRecord` + `.mixWithOthers`. À vérifier dans le code natif du plugin (ou à patcher) au moment du build.

## Build (sur Mac)
~~~bash
pnpm install
pnpm --filter web build          # produit apps/web/dist
cd apps/web
npx cap sync                     # copie dist + registre le plugin
npx cap open ios                 # ouvre Xcode
# Dans Xcode : sélectionner l'équipe (Apple Developer), le Bundle ID, puis Run / Archive.
~~~

## Pour aller plus loin
- Diarisation + hébergement UE : bascule `TRANSCRIBE_PROVIDER=gladia`.
- Le provider de transcription et l'upload Blob sont déjà côté serveur (inchangés).
