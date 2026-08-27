import { useCallback, useEffect, useRef, useState } from 'react';
import { Recorder, type SegmentChunk } from '../lib/audio/recorder';
import { saveSegment } from '../lib/db';

export type RecorderState = 'idle' | 'starting' | 'recording' | 'paused';

export function useRecorder(noteId: string | null) {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [segmentCount, setSegmentCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const startAtRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const rafRef = useRef(0);

  const tick = useCallback(() => {
    const r = recorderRef.current;
    if (r) {
      setLevel(r.getLevel());
      if (r.state === 'recording') {
        setElapsed(pausedTotalRef.current + (Date.now() - startAtRef.current));
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    setError(null);
    setState('starting');
    try {
      const r = new Recorder(async (segment) => {
        if (noteId) {
          await saveSegment({
            id: crypto.randomUUID(),
            noteId,
            index: segment.index,
            blob: segment.blob,
            mimeType: segment.mimeType,
            durationMs: segment.durationMs,
          });
        }
        setSegmentCount((c) => c + 1);
      });
      recorderRef.current = r;
      await r.start();
      startAtRef.current = Date.now();
      pausedTotalRef.current = 0;
      setElapsed(0);
      setSegmentCount(0);
      setState('recording');
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      recorderRef.current = null;
      setError(e instanceof Error ? e.message : "Impossible d'accéder au micro.");
      setState('idle');
    }
  }, [noteId, tick]);

  const pause = useCallback(() => {
    recorderRef.current?.pause();
    pausedTotalRef.current += Date.now() - startAtRef.current;
    setState('paused');
  }, []);

  const resume = useCallback(() => {
    recorderRef.current?.resume();
    startAtRef.current = Date.now();
    setState('recording');
  }, []);

  const stop = useCallback(async (): Promise<SegmentChunk[]> => {
    cancelAnimationFrame(rafRef.current);
    const r = recorderRef.current;
    recorderRef.current = null;
    const segments = r ? await r.stop() : [];
    setLevel(0);
    setState('idle');
    return segments;
  }, []);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return { state, elapsed, level, segmentCount, error, start, pause, resume, stop };
}
