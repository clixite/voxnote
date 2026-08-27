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
  const isRecording = state !== 'idle';

  const handlePress = async () => {
    if (state === 'idle') {
      await start();
    } else {
      await stop();
      onStop();
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 py-8">
      <div className="h-2 w-64 overflow-hidden rounded-full bg-neutral-800">
        <div
          className="h-full rounded-full bg-indigo-500 transition-[width] duration-75"
          style={{ width: `${Math.round(level * 100)}%` }}
        />
      </div>

      <div className="font-mono text-3xl tabular-nums">{formatTime(elapsed)}</div>

      {isRecording && (
        <div className="flex items-center gap-3">
          {state === 'recording' ? (
            <button onClick={pause} className="rounded-full border border-neutral-700 px-5 py-2 text-sm">
              Pause
            </button>
          ) : (
            <button onClick={resume} className="rounded-full border border-neutral-700 px-5 py-2 text-sm">
              Reprendre
            </button>
          )}
          <span className="text-xs text-neutral-500">{segmentCount} segment(s)</span>
        </div>
      )}

      <button
        onClick={handlePress}
        aria-label={isRecording ? 'Arrêter' : 'Enregistrer'}
        className={`flex h-20 w-20 items-center justify-center rounded-full text-2xl transition-colors ${
          isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-indigo-500 hover:bg-indigo-600'
        }`}
      >
        {isRecording ? '■' : '🎙️'}
      </button>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {isRecording && (
        <p className="max-w-xs text-center text-xs text-amber-400/90">
          Garde l'écran allumé pendant l'enregistrement.
        </p>
      )}
    </div>
  );
}
