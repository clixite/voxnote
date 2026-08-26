import type { NoteStatus } from '@voxnote/shared'

const initialStatus: NoteStatus = 'recording'

export default function App() {
  return (
    <main className="flex h-full min-h-screen flex-col items-center justify-center gap-3 bg-neutral-950 text-neutral-100">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-indigo-500 text-2xl">🎙️</div>
      <h1 className="text-2xl font-semibold">VoxNote</h1>
      <p className="text-sm text-neutral-400">Enregistrer · Transcrire · Copier</p>
      <p className="text-xs text-neutral-600">coquille v0.1 — statut initial : {initialStatus}</p>
    </main>
  )
}
