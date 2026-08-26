import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VoxNote",
    short_name: "VoxNote",
    description:
      "Enregistrez une note vocale, obtenez le texte, copiez-le ou partagez-le.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "fr",
    theme_color: "#111827",
    background_color: "#111827",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
