# Choix du provider de transcription

> Les tarifs ci-dessous sont des **ordres de grandeur** relevés sur les pages
> publiques des fournisseurs. Ils changent souvent : à revalider en début de
> Phase 3 avant de figer le défaut, via Context7 ou les pages pricing.

## Comparatif pour 1 h d'audio

| Critère | **Groq** `whisper-large-v3-turbo` | **OpenAI** `whisper-1` / `gpt-4o-mini-transcribe` | **Gladia** |
|---|---|---|---|
| Coût / 1 h d'audio | ~0,04 $ | ~0,36 $ (whisper-1) · ~0,18 $ (4o-mini-transcribe) | ~0,6 € (offre d'entrée, dégressif au volume) |
| Latence (10 min d'audio) | quelques secondes (facteur temps réel très élevé) | ~20-40 s | ~30-60 s |
| Qualité fr / nl | Whisper large-v3-turbo : très bonne en fr, correcte en nl | équivalente (même famille de modèles) | bonne, moteur maison + Whisper |
| Détection de langue | oui | oui | oui |
| Limite de taille | ~25 Mo/fichier (~100 Mo sur l'offre dev) | ~25 Mo/fichier | plus permissive |
| Hébergement des données | **États-Unis** | **États-Unis** (résidence UE possible selon l'offre) | **Union européenne** (France) |
| Entraînement sur les données | non par défaut (API) | non par défaut (API) | non |
| Maturité de l'API | jeune, compatible OpenAI | la plus stable | correcte, doc claire |

Notes :
- Le découpage en segments de ~5 min rend la limite de taille par fichier non
  contraignante chez les trois : un segment de 5 min en Opus pèse quelques Mo.
- L'API Groq est compatible avec le schéma OpenAI : `GroqProvider` et
  `OpenAIProvider` partagent l'essentiel du code, seule l'URL de base et le nom
  du modèle changent. Le coût d'avoir les deux est quasi nul.

## Recommandation

**Défaut technique : Groq (`whisper-large-v3-turbo`).**
Il est un ordre de grandeur moins cher que les alternatives et nettement plus
rapide, ce qui sert directement le cas d'usage numéro 1 : parler, attendre
quelques secondes, copier. À 0,04 $/h, un usage de 2 h par semaine coûte environ
4 $ par an — le coût de transcription cesse d'être un sujet.

**Mais un point mérite ton arbitrage avant la Phase 3 :**

Groq et OpenAI hébergent aux États-Unis. Le prompt impose « défaut : groq » et
« RGPD » dans la même page. Les deux tiennent si les notes ne contiennent que
tes propres propos. Ils tiennent moins bien dès qu'une note enregistre une
réunion, un client ou un tiers : on transfère alors hors UE des données
personnelles de personnes qui n'ont rien signé.

Recommandation concrète :
1. `TRANSCRIBE_PROVIDER=groq` en développement et en preview — vitesse et coût,
   données de test uniquement.
2. En production, deux cas :
   - notes strictement personnelles → `groq`, avec la page confidentialité qui
     mentionne explicitement le transfert vers les États-Unis ;
   - notes pouvant contenir des tiers (réunions, entretiens) → `gladia`, pour
     rester dans l'UE. Surcoût réel : environ 0,55 € par heure d'audio, soit
     quelques euros par an à ton volume.
3. Dans les deux cas la bascule est une variable d'environnement, pas un
   refactor : l'interface `TranscriptionProvider` est écrite dès le premier
   ticket backend, avec les trois implémentations. Décider maintenant n'est pas
   irréversible ; ne rien décider et coder en dur chez un fournisseur le serait.

**Ce que j'attends de toi au STOP de Phase 0 :** un choix pour la production —
`groq` (assumé, mentionné dans la page confidentialité) ou `gladia` (UE, quelques
euros par an de plus). Par défaut, si tu ne tranches pas, j'implémente les trois
et je laisse `groq` en preview, `gladia` en prod : c'est le choix le plus difficile
à regretter.

## Interface visée

```ts
export interface TranscriptionResult {
  text: string
  language: string           // code ISO détecté ou forcé
  durationMs: number
  provider: ProviderId
}

export interface TranscriptionProvider {
  readonly id: ProviderId    // 'groq' | 'openai' | 'gladia'
  transcribe(input: {
    audioUrl: string         // URL du blob Vercel, jamais le binaire
    mimeType: string
    language?: 'fr' | 'nl' | 'en'   // absent = détection auto
    signal?: AbortSignal
  }): Promise<TranscriptionResult>
}
```

Toute erreur provider est traduite en `TranscriptionError` avec un message
utilisateur en français (quota, fichier illisible, réseau, indisponibilité) et
un indicateur `retryable` qui pilote le retry exponentiel (3 tentatives).
