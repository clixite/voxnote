/**
 * Faux `MediaStream`/`MediaStreamTrack` minimal pour les tests : juste assez
 * pour que le moteur de segmentation et les hooks puissent le manipuler
 * (passage à `MediaRecorder`, arrêt des pistes à la fin de l'enregistrement).
 */
export interface FakeMediaStreamTrack {
  kind: "audio";
  readyState: "live" | "ended";
  stop: () => void;
}

export function createFakeMediaStream(): MediaStream {
  const track: FakeMediaStreamTrack = {
    kind: "audio",
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
  };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
    active: true,
  } as unknown as MediaStream;
}
