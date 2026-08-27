export const SEGMENT_MS = 5 * 60 * 1000;

export interface SegmentChunk {
  blob: Blob;
  index: number;
  mimeType: string;
  durationMs: number;
}

export function detectMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

interface AudioSession {
  stream: MediaStream;
  mimeType: string;
  analyser: AnalyserNode;
  audioContext: AudioContext;
}

async function openAudioSession(): Promise<AudioSession> {
  const mimeType = detectMimeType();
  if (!mimeType) throw new Error("L'enregistrement audio n'est pas supporté par ce navigateur.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new AudioContext();
  if (audioContext.state === 'suspended') await audioContext.resume();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);
  return { stream, mimeType, analyser, audioContext };
}

export class Recorder {
  segments: SegmentChunk[] = [];
  state: 'idle' | 'recording' | 'paused' = 'idle';
  mimeType = '';
  private session: AudioSession | null = null;
  private mr: MediaRecorder | null = null;
  private segmentStartedAt = 0;
  private segmentIndex = 0;
  private onSegment: ((s: SegmentChunk) => void) | undefined;

  constructor(onSegment?: (s: SegmentChunk) => void) {
    this.onSegment = onSegment;
  }

  async start(): Promise<void> {
    this.session = await openAudioSession();
    this.mimeType = this.session.mimeType;
    this.segments = [];
    this.segmentIndex = 0;
    this.segmentStartedAt = Date.now();
    this.mr = new MediaRecorder(this.session.stream, { mimeType: this.session.mimeType });
    this.mr.ondataavailable = (e) => {
      if (e.data.size > 0 && this.session) {
        const segment: SegmentChunk = {
          blob: e.data,
          index: this.segmentIndex++,
          mimeType: this.session.mimeType,
          durationMs: Date.now() - this.segmentStartedAt,
        };
        this.segmentStartedAt = Date.now();
        this.segments.push(segment);
        this.onSegment?.(segment);
      }
    };
    this.mr.start(SEGMENT_MS);
    this.state = 'recording';
  }

  pause(): void {
    if (this.mr && this.state === 'recording') {
      this.mr.pause();
      this.state = 'paused';
    }
  }

  resume(): void {
    if (this.mr && this.state === 'paused') {
      this.mr.resume();
      this.state = 'recording';
    }
  }

  stop(): Promise<SegmentChunk[]> {
    return new Promise((resolve) => {
      if (!this.mr) {
        this.cleanup();
        this.state = 'idle';
        resolve(this.segments);
        return;
      }
      this.mr.onstop = () => {
        this.cleanup();
        this.state = 'idle';
        resolve(this.segments);
      };
      if (this.mr.state === 'paused') this.mr.resume();
      this.mr.stop();
    });
  }

  getLevel(): number {
    if (!this.session) return 0;
    const data = new Uint8Array(this.session.analyser.frequencyBinCount);
    this.session.analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return Math.min(1, sum / data.length / 96);
  }

  private cleanup(): void {
    try {
      this.session?.stream.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      void this.session?.audioContext.close();
    } catch {}
    this.session = null;
    this.mr = null;
  }
}
