import Link from "next/link";
import LogoutButton from "../components/LogoutButton";

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

      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-describedby="enregistrer-statut"
          className="flex h-40 w-40 flex-col items-center justify-center gap-2 rounded-full bg-slate-800 text-slate-400 shadow-inner ring-1 ring-slate-700 disabled:cursor-not-allowed sm:h-48 sm:w-48"
        >
          <MicIcon className="h-12 w-12" />
          <span className="text-lg font-medium">Enregistrer</span>
        </button>
        <p id="enregistrer-statut" className="text-sm text-slate-500">
          Bientôt disponible
        </p>
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

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}
