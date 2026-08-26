import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VoxNote",
  description:
    "Enregistrez une note vocale, obtenez le texte, copiez-le ou partagez-le.",
  applicationName: "VoxNote",
  appleWebApp: {
    capable: true,
    title: "VoxNote",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#111827",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" className="h-full">
      <body className="flex min-h-full flex-col bg-slate-950 text-slate-50 antialiased">
        {children}
      </body>
    </html>
  );
}
