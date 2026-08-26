import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import LoginForm from "./LoginForm";

export const metadata: Metadata = {
  title: "Connexion — VoxNote",
  description: "Accès protégé par mot de passe partagé.",
};

export default function LoginPage() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-10">
      <header className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">VoxNote</h1>
        <p className="mt-2 text-sm text-slate-400">
          Accès partagé à l&apos;application : entre le mot de passe commun
          pour continuer. Ce n&apos;est pas un compte personnel.
        </p>
      </header>

      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>

      <p className="text-center text-xs text-slate-500">
        <Link
          href="/confidentialite"
          className="underline decoration-slate-600 underline-offset-2 hover:text-slate-300"
        >
          En savoir plus sur la confidentialité
        </Link>
      </p>
    </div>
  );
}
