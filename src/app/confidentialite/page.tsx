import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Confidentialité — VoxNote",
  description: "Ce que VoxNote collecte, où vont tes données et comment les supprimer.",
};

export default function ConfidentialitePage() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <header>
        <p className="text-sm">
          <Link
            href="/"
            className="underline decoration-slate-600 underline-offset-2 hover:text-slate-300"
          >
            ← Retour
          </Link>
        </p>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">
          Confidentialité
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Cette page décrit le fonctionnement prévu de VoxNote. Elle est
          provisoire et sera complétée avant l&apos;ouverture de l&apos;accès.
        </p>
      </header>

      <section aria-labelledby="acces" className="flex flex-col gap-2">
        <h2 id="acces" className="text-lg font-medium">
          Accès à l&apos;application
        </h2>
        <p className="text-sm text-slate-300">
          VoxNote est protégée par un mot de passe unique, partagé avec un
          nombre restreint de personnes. Il n&apos;y a ni compte individuel,
          ni inscription, ni identifiant nominatif : on sait seulement
          qu&apos;une personne connaissait le mot de passe, pas laquelle.
        </p>
      </section>

      <section aria-labelledby="session" className="flex flex-col gap-2">
        <h2 id="session" className="text-lg font-medium">
          Cookie de session
        </h2>
        <p className="text-sm text-slate-300">
          Après avoir saisi le mot de passe, un cookie nommé{" "}
          <strong className="font-medium text-slate-100">vox_session</strong>{" "}
          est déposé sur ton appareil. Il ne contient aucune donnée
          personnelle : ni email, ni nom, ni identifiant. Il contient
          seulement une signature qui prouve que le mot de passe a été saisi
          correctement.
        </p>
        <p className="text-sm text-slate-300">
          Ce cookie dure{" "}
          <strong className="font-medium text-slate-100">30 jours</strong>.
          Après ce délai, tu devras ressaisir le mot de passe. Il est
          supprimé immédiatement si tu te déconnectes.
        </p>
        <p className="text-sm text-slate-300">
          Ce cookie est strictement nécessaire au fonctionnement de
          l&apos;application : sans lui, impossible de rester connecté. Il ne
          sert pas à la mesure d&apos;audience, à la publicité ou au suivi.
          Aucune bannière de consentement n&apos;est donc requise.
        </p>
      </section>

      <section aria-labelledby="donnees" className="flex flex-col gap-2">
        <h2 id="donnees" className="text-lg font-medium">
          Ce qui est enregistré
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
          <li>L&apos;audio de tes mémos vocaux, le temps de la transcription.</li>
          <li>
            Le texte transcrit, qui reste stocké dans le navigateur de
            l&apos;appareil utilisé pour l&apos;enregistrement (aucune
            synchronisation entre appareils).
          </li>
        </ul>
      </section>

      <section aria-labelledby="destination" className="flex flex-col gap-2">
        <h2 id="destination" className="text-lg font-medium">
          Où va l&apos;audio
        </h2>
        <p className="text-sm text-slate-300">
          Chaque enregistrement est envoyé directement à un espace de
          stockage temporaire (Vercel Blob), puis transmis à un service de
          transcription externe. Par défaut, ce service est{" "}
          <strong className="font-medium text-slate-100">Groq</strong>, dont
          les serveurs de traitement sont situés aux{" "}
          <strong className="font-medium text-slate-100">
            États-Unis
          </strong>
          . L&apos;audio n&apos;est utilisé que pour produire le texte ; il
          n&apos;est ni republié, ni utilisé à d&apos;autres fins par
          VoxNote.
        </p>
      </section>

      <section aria-labelledby="conservation" className="flex flex-col gap-2">
        <h2 id="conservation" className="text-lg font-medium">
          Durée de conservation
        </h2>
        <p className="text-sm text-slate-300">
          L&apos;audio stocké côté serveur est supprimé automatiquement au
          bout de <strong className="font-medium text-slate-100">7 jours</strong>,
          par une purge quotidienne. Le texte transcrit n&apos;a pas de durée
          de conservation imposée : il reste sur l&apos;appareil tant que
          tu ne le supprimes pas toi-même.
        </p>
      </section>

      <section aria-labelledby="suppression" className="flex flex-col gap-2">
        <h2 id="suppression" className="text-lg font-medium">
          Supprimer une note
        </h2>
        <p className="text-sm text-slate-300">
          Supprimer une note efface à la fois l&apos;audio (côté serveur) et
          le texte (dans le navigateur). Vider les données de site du
          navigateur supprime également toutes les notes qui y sont
          conservées.
        </p>
      </section>

      <section aria-labelledby="suivi" className="flex flex-col gap-2">
        <h2 id="suivi" className="text-lg font-medium">
          Aucun suivi supplémentaire
        </h2>
        <p className="text-sm text-slate-300">
          VoxNote n&apos;utilise aucun autre cookie et aucun outil de mesure
          d&apos;audience ou de suivi.
        </p>
      </section>

      <footer className="pt-4 text-xs text-slate-500">
        Cette page évoluera à mesure que les fonctionnalités décrites
        seront mises en place.
      </footer>
    </div>
  );
}
