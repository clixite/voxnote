import { useCallback, useEffect, useState } from 'react';
import { Recorder } from './components/Recorder';
import { listNotes, saveNote, type NoteRecord } from './lib/db';

export default function App() {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const refresh = useCallback(async () => setNotes(await listNotes()), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startNew = async () => {
    const id = crypto.randomUUID();
    const note: NoteRecord = {
      id,
      title: '',
      transcript: '',
      status: 'recording',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveNote(note);
    setActiveId(id);
    await refresh();
  };

  const handleStop = async () => {
    if (!activeId) return;
    const now = Date.now();
    const title = `Note du ${new Date(now).toLocaleString('fr-FR')}`;
    const existing = notes.find((n) => n.id === activeId);
    if (existing) {
      await saveNote({ ...existing, title, status: 'processing', updatedAt: now });
    }
    setActiveId(null);
    await refresh();
  };

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-md px-4 py-6">
        <header className="mb-8 flex items-center justify-between">
          <h1 className="text-xl font-semibold">VoxNote</h1>
          <span className="text-xs text-neutral-500">Enregistrer · Transcrire · Copier</span>
        </header>

        {activeId ? (
          <Recorder noteId={activeId} onStop={handleStop} />
        ) : (
          <div className="flex flex-col items-center gap-4 py-8">
            <button
              onClick={startNew}
              className="flex h-20 w-20 items-center justify-center rounded-full bg-indigo-500 text-2xl transition-colors hover:bg-indigo-600"
              aria-label="Nouvel enregistrement"
            >
              🎙️
            </button>
            <p className="text-sm text-neutral-400">Touchez pour enregistrer</p>
          </div>
        )}

        <ul className="mt-8 space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg border border-neutral-800 p-3">
              <div className="font-medium">{n.title || 'Sans titre'}</div>
              <div className="mt-1 text-sm text-neutral-400">
                {n.status === 'done'
                  ? n.transcript
                  : n.status === 'processing'
                    ? 'Transcription en cours…'
                    : 'Enregistré'}
              </div>
            </li>
          ))}
          {notes.length === 0 && (
            <li className="text-center text-sm text-neutral-600">Aucune note pour l'instant.</li>
          )}
        </ul>
      </div>
    </main>
  );
}
