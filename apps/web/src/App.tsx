import { useCallback, useEffect, useState } from 'react';
import { Recorder } from './components/Recorder';
import { deleteNote, getNote, getSegments, listNotes, saveNote, type NoteRecord } from './lib/db';
import { extFor, transcribe, uploadSegment } from './lib/api';

export default function App() {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
    if (existing) await saveNote({ ...existing, title, status: 'processing', updatedAt: now });
    setActiveId(null);
    await refresh();

    setBusy(true);
    try {
      const segments = await getSegments(activeId);
      if (segments.length === 0) throw new Error('Aucun segment enregistré.');
      const uploaded: { url: string; mimeType: string; index: number }[] = [];
      for (const seg of segments) {
        const url = await uploadSegment(
          `notes/${activeId}/${seg.index}.${extFor(seg.mimeType)}`,
          seg.blob,
          seg.mimeType,
        );
        uploaded.push({ url, mimeType: seg.mimeType, index: seg.index });
      }
      const transcript = await transcribe(uploaded);
      const note = await getNote(activeId);
      if (note) await saveNote({ ...note, transcript, status: 'done', updatedAt: Date.now() });
    } catch {
      const note = await getNote(activeId);
      if (note) await saveNote({ ...note, status: 'error', updatedAt: Date.now() });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {}
  };

  const remove = async (id: string) => {
    await deleteNote(id);
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

        {busy && <p className="my-4 text-center text-sm text-indigo-400">Transcription en cours…</p>}

        <ul className="mt-8 space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg border border-neutral-800 p-3">
              <div className="flex items-center justify-between">
                <div className="font-medium">{n.title || 'Sans titre'}</div>
                <button onClick={() => remove(n.id)} className="text-xs text-neutral-500 hover:text-red-400">
                  Suppr.
                </button>
              </div>
              {n.status === 'processing' && (
                <div className="mt-1 text-sm text-indigo-400">Transcription en cours…</div>
              )}
              {n.status === 'error' && (
                <div className="mt-1 text-sm text-red-400">Échec de la transcription.</div>
              )}
              {n.status === 'done' && n.transcript && (
                <>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-200">{n.transcript}</p>
                  <button
                    onClick={() => copy(n.id, n.transcript)}
                    className="mt-2 rounded-full bg-indigo-500 px-4 py-1.5 text-xs"
                  >
                    {copiedId === n.id ? 'Copié ✓' : 'Copier'}
                  </button>
                </>
              )}
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
