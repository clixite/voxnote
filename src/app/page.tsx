import Link from "next/link";
import LogoutButton from "@/components/LogoutButton";
import RecorderScreen from "@/components/RecorderScreen";

export default function HomePage() {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="px-6 pt-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">VoxNote</h1>
        <p className="mt-2 text-sm text-slate-400">
          Enregistrez une note vocale, obtenez le texte, copiez-le ou
          partagez-le.
        </p>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 py-8">
        <RecorderScreen />
      </main>

      <footer className="flex items-center justify-center gap-4 px-6 pb-8 text-center text-xs text-slate-500">
        <Link
          href="/confidentialite"
          className="underline decoration-slate-600 underline-offset-2 hover:text-slate-300"
        >
          Confidentialité
        </Link>
        <span aria-hidden="true">·</span>
        <LogoutButton />
      </footer>
    </div>
  );
}
