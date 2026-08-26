"use client";

export interface OtherTabNoticeProps {
  createdAt: number;
}

/**
 * S'affiche quand la note interrompue détectée au montage porte un marqueur
 * frais appartenant à un AUTRE onglet (voir activeRecordingMarker.ts) :
 * cet onglet est probablement encore en train de l'enregistrer. Ne propose
 * jamais de « Reprendre » ici — ce serait exactement le scénario à deux
 * moteurs en parallèle qui produit des `seq` dupliqués et écrase un segment
 * dans Vercel Blob (ticket B4). Purement informatif, sans action : la seule
 * sortie sûre est de terminer l'enregistrement dans l'autre onglet.
 */
export default function OtherTabNotice({ createdAt }: OtherTabNoticeProps) {
  const when = new Date(createdAt).toLocaleString("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  });

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
    >
      <span aria-hidden="true" className="mt-0.5 text-base leading-none">
        ⚠
      </span>
      <p>
        <strong className="font-semibold">
          Enregistrement du {when} en cours dans un autre onglet.
        </strong>{" "}
        Termine-le là-bas avant de le reprendre ici : l&apos;enregistrer aux
        deux endroits à la fois écraserait une partie du son déjà capturé.
      </p>
    </div>
  );
}
