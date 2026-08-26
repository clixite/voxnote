// Génère les icônes PWA de VoxNote (public/icons/*.png) à partir d'un SVG
// simple : un carré sombre avec un pictogramme de micro blanc.
//
// Usage : node scripts/generate-icons.mjs
//
// Deux familles sont produites :
//  - "any"       : coins arrondis, tolère un padding libre.
//  - "maskable"  : fond plein bord à bord (les OS appliquent leur propre
//                  masque), pictogramme contenu dans la zone de sécurité
//                  (~80 % du cadre) pour ne jamais être rogné.
//
// Voir docs/... (aucune dépendance réseau : tout est généré localement).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const outDir = path.join(rootDir, "public", "icons");
const appDir = path.join(rootDir, "src", "app");

const BACKGROUND = "#111827"; // gris-bleu très sombre, cohérent avec le manifest
const FOREGROUND = "#ffffff";

/**
 * @param {{ size: number; cornerRadiusRatio: number; iconScale: number }} opts
 */
function buildSvg({ size, cornerRadiusRatio, iconScale }) {
  const r = size * cornerRadiusRatio;
  const cx = size / 2;
  const cy = size / 2;

  // Pictogramme de micro dessiné à l'échelle d'un cadre de 100x100,
  // puis mis à l'échelle et centré dans le canevas final.
  const micWidth = 100 * iconScale;
  const scale = micWidth / 100;
  const offsetX = cx - micWidth / 2;
  const offsetY = cy - (100 * scale) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${BACKGROUND}" />
    <g transform="translate(${offsetX}, ${offsetY}) scale(${scale})" fill="${FOREGROUND}">
      <rect x="38" y="8" width="24" height="46" rx="12" ry="12" />
      <path
        d="M 26 46 a 1 1 0 0 1 2 0 c 0 12.15 9.85 22 22 22 s 22 -9.85 22 -22 a 1 1 0 0 1 2 0 c 0 13.02 -10.31 23.65 -23 24.46 V 88 h 10 a 1 1 0 0 1 0 2 H 39 a 1 1 0 0 1 0 -2 h 10 V 70.46 C 36.31 69.65 26 59.02 26 46 Z"
      />
    </g>
  </svg>`;
}

/** @type {Array<{ file: string; size: number; cornerRadiusRatio: number; iconScale: number }>} */
const targets = [
  { file: "icon-192.png", size: 192, cornerRadiusRatio: 0.22, iconScale: 0.58 },
  { file: "icon-512.png", size: 512, cornerRadiusRatio: 0.22, iconScale: 0.58 },
  {
    file: "icon-maskable-512.png",
    size: 512,
    cornerRadiusRatio: 0, // fond plein bord à bord : le masque est appliqué par l'OS
    iconScale: 0.42, // reste dans la zone de sécurité (~80 % du cadre)
  },
];

// Icônes servies directement par les conventions de fichiers de Next.js
// (src/app/icon.png → favicon, src/app/apple-icon.png → apple-touch-icon).
/** @type {Array<{ file: string; size: number; cornerRadiusRatio: number; iconScale: number; dir: string }>} */
const appIconTargets = [
  { file: "icon.png", size: 48, cornerRadiusRatio: 0.22, iconScale: 0.58, dir: appDir },
  { file: "apple-icon.png", size: 180, cornerRadiusRatio: 0.22, iconScale: 0.58, dir: appDir },
];

async function generate(target, dir) {
  const svg = buildSvg(target);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const dest = path.join(dir, target.file);
  await writeFile(dest, png);
  console.log(`✓ ${path.relative(process.cwd(), dest)} (${target.size}x${target.size})`);
}

async function main() {
  await mkdir(outDir, { recursive: true });

  for (const target of targets) {
    await generate(target, outDir);
  }
  for (const target of appIconTargets) {
    await generate(target, target.dir);
  }
}

main().catch((error) => {
  console.error("Échec de la génération des icônes :", error);
  process.exitCode = 1;
});
