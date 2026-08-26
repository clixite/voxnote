/**
 * Calcul pur du niveau sonore normalisé pour le VU-mètre, séparé de tout
 * `AudioContext`/`AnalyserNode` pour rester testable sans Web Audio API.
 * L'UI (autre ticket) consomme `level` (0..1) exposé par `useRecorder`.
 */

/**
 * RMS d'un buffer temporel `Uint8Array` renvoyé par
 * `AnalyserNode.getByteTimeDomainData` (échantillons 0-255, silence = 128),
 * normalisé sur 0..1.
 */
export function computeNormalizedLevel(timeDomainData: Uint8Array): number {
  if (timeDomainData.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i += 1) {
    const centered = (timeDomainData[i] ?? 128) - 128;
    sumSquares += centered * centered;
  }
  const rms = Math.sqrt(sumSquares / timeDomainData.length);
  return Math.min(1, rms / 128);
}
