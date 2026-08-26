import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  // Le service worker n'est généré (et actif) qu'en production : en dev,
  // Turbopack sert les fichiers et un SW en cache gênerait le rechargement.
  disable: process.env.NODE_ENV === "development",
});

export default withSerwist(nextConfig);
