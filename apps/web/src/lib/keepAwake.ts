let wakeLock: { release(): Promise<void> } | null = null;
let cleanupVideo: (() => void) | null = null;

/** Garde l'écran allumé pendant l'enregistrement. */
export async function requestKeepAwake(): Promise<void> {
  if (wakeLock || cleanupVideo) return;

  // 1) Wake Lock API — Chrome/Edge (Windows + Android)
  try {
    const nav = navigator as any;
    if (nav.wakeLock?.request) {
      const lock = await nav.wakeLock.request('screen');
      if (lock) {
        wakeLock = lock;
        return;
      }
    }
  } catch {}

  // 2) Filet : vidéo 1px animée (canvas → MediaStream) pour iPhone Safari
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext('2d');
    let f = 0;
    const stream = canvas.captureStream(10);
    const timer = window.setInterval(() => {
      if (ctx) {
        ctx.fillStyle = f++ % 2 ? '#000' : '#222';
        ctx.fillRect(0, 0, 2, 2);
      }
    }, 120);
    video.srcObject = stream;
    document.body.appendChild(video);
    await video.play();
    cleanupVideo = () => {
      window.clearInterval(timer);
      video.pause();
      video.remove();
    };
  } catch {}
}

export function releaseKeepAwake(): void {
  try {
    wakeLock?.release();
  } catch {}
  wakeLock = null;
  if (cleanupVideo) {
    cleanupVideo();
    cleanupVideo = null;
  }
}
