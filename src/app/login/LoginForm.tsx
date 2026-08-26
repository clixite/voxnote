"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const NETWORK_ERROR_MESSAGE =
  "Connexion impossible. Vérifie ta connexion internet.";
const GENERIC_ERROR_MESSAGE =
  "Une erreur est survenue. Réessaie dans quelques instants.";

/**
 * N'accepte qu'une redirection interne relative (ex. "/notes/42").
 * Rejette les URLs protocole-relatives ("//site.example") qui
 * enverraient l'utilisateur hors de l'application.
 */
function sanitizeRedirect(from: string | null): string {
  if (from && from.startsWith("/") && !from.startsWith("//")) {
    return from;
  }
  return "/";
}

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (response.status === 204) {
        const destination = sanitizeRedirect(searchParams.get("from"));
        router.push(destination);
        return;
      }

      let message = GENERIC_ERROR_MESSAGE;
      try {
        const data = (await response.json()) as { message?: string };
        if (data.message) {
          message = data.message;
        }
      } catch {
        // Réponse sans corps JSON exploitable : on garde le message générique.
      }
      setError(message);
      setIsSubmitting(false);
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label
          htmlFor="password"
          className="text-sm font-medium text-slate-200"
        >
          Mot de passe
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={error ? "password-erreur" : undefined}
          disabled={isSubmitting}
          className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-base text-slate-50 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-60"
        />
      </div>

      {error && (
        <p id="password-erreur" role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        className="flex h-14 w-full items-center justify-center rounded-full bg-slate-50 text-base font-medium text-slate-950 shadow transition disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300"
      >
        {isSubmitting ? "Connexion…" : "Se connecter"}
      </button>
    </form>
  );
}
