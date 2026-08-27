import { useCallback, useEffect, useState } from 'react';
import { Recorder } from './components/Recorder';
import { deleteNote, getNote, getSegments, listNotes, saveNote, type NoteRecord } from './lib/db';
import { extFor, transcribe, uploadSegment } from './lib/api';
import { toWav } from './lib/audio/toWav';
import { requestKeepAwake, releaseKeepAwake } from './lib/keepAwake';

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function deriveTitle(text: string, recordedAt: number): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ');
  const date = new Date(recordedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  return words ? `Note du ${date} — ${words}…` : `Note du ${date}`;
}

export default function App() {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [showPrivacy, setShowPrivacy] = useState(false);

  const refresh = useCallback(async () => setNotes(await listNotes()), []);
  useEffect(() => {
    void refresh();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
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

  const processNote = async (noteId: string) => {
    setBusy(true);
    await requestKeepAwake();
    try {
      const existing = await getNote(noteId);
      if (existing) await saveNote({ ...existing, status: 'processing', error: undefined, updatedAt: Date.now() });
      const segments = await getSegments(noteId);
      if (segments.length === 0) throw new Error('Aucun segment enregistré.');
      const totalMs = segments.reduce((s, seg) => s + seg.durationMs, 0);
      const uploaded: { url: string; mimeType: string; index: number }[] = [];
      for (const seg of segments) {
        let blob = seg.blob;
        let mimeType = seg.mimeType;
        try {
          blob = await toWav(seg.blob);
          mimeType = 'audio/wav';
        } catch {}
        const url = await uploadSegment(
          `notes/${noteId}/${seg.index}.${extFor(mimeType)}`,
          blob,
          mimeType,
        );
        uploaded.push({ url, mimeType, index: seg.index });
      }
      const transcript = await transcribe(uploaded);
      const note = await getNote(noteId);
      if (note) {
        const title = transcript.trim() ? deriveTitle(transcript, note.createdAt) : note.title;
        await saveNote({
          ...note,
          transcript,
          status: 'done',
          error: undefined,
          durationMs: totalMs,
          title,
          updatedAt: Date.now(),
        });
      }
    } catch (e) {
      const note = await getNote(noteId);
      if (note) await saveNote({ ...note, status: 'error', error: e instanceof Error ? e.message : String(e), updatedAt: Date.now() });
    } finally {
      releaseKeepAwake();
      setBusy(false);
      await refresh();
    }
  };

  const handleStop = async () => {
    if (!activeId) return;
    const now = Date.now();
    const title = `Note du ${new Date(now).toLocaleString('fr-FR')}`;
    const existing = notes.find((n) => n.id === activeId);
    if (existing) await saveNote({ ...existing, title, status: 'processing', updatedAt: now });
    setActiveId(null);
    await refresh();
    await processNote(activeId);
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

        {!online && (
          <div className="mb-4 rounded-lg border border-amber-700/40 bg-amber-900/20 p-3 text-sm text-amber-300">
            Hors ligne — l'enregistrement fonctionne, la transcription attendra le réseau.
          </div>
        )}

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
                <div className="flex items-center gap-3">
                  {n.durationMs ? <span className="text-xs text-neutral-500">{formatTime(n.durationMs)}</span> : null}
                  <button onClick={() => remove(n.id)} className="text-xs text-neutral-500 hover:text-red-400">
                    Suppr.
                  </button>
                </div>
              </div>
              {n.status === 'processing' && <div className="mt-1 text-sm text-indigo-400">Transcription en cours…</div>}
              {n.status === 'error' && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm text-red-400">{n.error ?? 'Échec de la transcription.'}</span>
                  <button onClick={() => processNote(n.id)} className="text-xs text-indigo-400 hover:text-indigo-300">
                    Réessayer
                  </button>
                </div>
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
          {notes.length === 0 && <li className="text-center text-sm text-neutral-600">Aucune note pour l'instant.</li>}
        </ul>

        <footer className="mt-10 border-t border-neutral-800 pt-4 text-center text-xs text-neutral-500">
          <button onClick={() => setShowPrivacy((v) => !v)} className="hover:text-neutral-300">Confidentialité</button>
        </footer>

        {showPrivacy && (
          <section className="mt-6 rounded-lg border border-neutral-800 p-4 text-sm text-neutral-300">
            <h2 className="mb-2 font-semibold">Vos données</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>L'audio est enregistré en local et supprimé juste après la transcription.</li>
              <li>Le texte transcrit est stocké uniquement sur votre appareil (IndexedDB).</li>
              <li>La transcription est réalisée par un fournisseur tiers (Groq) ; l'audio n'est pas conservé au-delà.</li>
              <li>Aucun compte, aucun cookie de suivi.</li>
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
