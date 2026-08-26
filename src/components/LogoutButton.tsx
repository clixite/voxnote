"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleClick() {
    setIsSubmitting(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // La déconnexion locale doit réussir même si l'appel réseau échoue :
      // on renvoie vers /login dans tous les cas.
    } finally {
      router.push("/login");
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isSubmitting}
      className="text-xs text-slate-500 underline decoration-slate-700 underline-offset-2 hover:text-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
    >
      Se déconnecter
    </button>
  );
}
