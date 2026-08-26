# VoxNote

PWA d'enregistrement vocal et de transcription. Enregistrer, transcrire, copier
le texte. Rien d'autre en v1.

Cibles : navigateur Windows, iPhone (Safari), Android (Chrome), installable
comme application via PWA.

## État du projet

**Phase 0 — cadrage. Aucun code applicatif à ce stade.**

| Document | Contenu |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Périmètre v1, cas d'usage, critères de succès |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Schéma, flux, modèle de données, décisions |
| [`docs/PROVIDER-TRANSCRIPTION.md`](docs/PROVIDER-TRANSCRIPTION.md) | Comparatif Groq / OpenAI / Gladia et recommandation |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | Tickets des phases 1 à 6 avec critères d'acceptation |
| [`docs/RISQUES.md`](docs/RISQUES.md) | Top 5 des risques et parades |

## Kit Claude Code

- `CLAUDE.md` — contexte projet, contraintes non négociables, boucle de travail.
- `.claude/agents/` — 5 sous-agents : `dev-frontend`, `dev-backend`, `qa-tester`,
  `architecte-reviewer`, `docs-devops`.
- `.claude/skills/audio-web/` — pièges de la capture audio cross-platform,
  à lire avant tout code audio.
- `.mcp.json` — serveurs MCP du projet : Vercel (déploiement, Blob),
  Context7 (documentation à jour), Playwright (tests navigateur).

Le README d'installation et d'exploitation sera écrit en Phase 6.
