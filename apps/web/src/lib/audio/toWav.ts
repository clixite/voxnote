let ctx: AudioContext | null = null;
function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}
function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/** Convertit n'importe quel blob audio en WAV 16 kHz mono (format natif Whisper/Groq). */
export async function toWav(blob: Blob): Promise<Blob> {
  const ac = getCtx();
  const buffer = await ac.decodeAudioData(await blob.arrayBuffer());
  if (!buffer.length) throw new Error('audio décodé vide');
  const sr = 16000;
  const frames = Math.max(1, Math.round((buffer.length * sr) / buffer.sampleRate));
  const off = new OfflineAudioContext(1, frames, sr);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const data = rendered.getChannelData(0);
  const frames2 = rendered.length;
  const dataSize = frames2 * 2;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < frames2; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([wav], { type: 'audio/wav' });
}
