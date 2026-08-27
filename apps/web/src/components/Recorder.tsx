import { useRecorder } from '../hooks/useRecorder';

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

interface Props {
  noteId: string;
  onStop: () => void;
}

export function Recorder({ noteId, onStop }: Props) {
  const { state, elapsed, level, segmentCount, error, start, pause, resume, stop } = useRecorder(noteId);
  const isRecording = state === 'recording' || state === 'paused';
  const starting = state === 'starting';

  const handlePress = async () => {
    if (state === 'idle') {
      await start();
    } else {
      await stop();
      onStop();
    }
  };

  return (
    <div className="flex flex-col items-center gap-7 py-10">
      <div className="flex w-full max-w-xs flex-col items-center gap-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600 transition-[width] duration-75"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
        <div className="font-mono text-4xl font-light tracking-tight tabular-nums">{formatTime(elapsed)}</div>
      </div>

      {isRecording && (
        <div className="flex items-center gap-4">
          {state === 'recording' ? (
            <button onClick={pause} className="rounded-full border border-white/15 px-5 py-2 text-sm text-neutral-300 hover:bg-white/5">
              Pause
            </button>
          ) : (
            <button onClick={resume} className="rounded-full border border-white/15 px-5 py-2 text-sm text-neutral-300 hover:bg-white/5">
              Reprendre
            </button>
          )}
          <span className="text-xs text-neutral-500">{segmentCount} seg.</span>
        </div>
      )}

      <button
        onClick={handlePress}
        disabled={starting}
        aria-label={isRecording ? 'Arrêter' : 'Enregistrer'}
        className={`flex h-24 w-24 items-center justify-center rounded-full text-3xl transition-all disabled:opacity-70 ${
          isRecording
            ? 'bg-amber-500 text-neutral-950 record-pulse'
            : 'bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-lg shadow-indigo-900/40 hover:brightness-110'
        }`}
      >
        {starting ? '…' : isRecording ? '■' : '🎙️'}
      </button>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {isRecording && (
        <p className="max-w-xs text-center text-xs text-amber-300/80">Garde l'écran allumé pendant l'enregistrement.</p>
      )}
    </div>
  );
}
