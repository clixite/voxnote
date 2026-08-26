import type { Segment } from "@/types/notes";

/**
 * Vrai si `tabId` a le droit de réserver ce segment : libre (jamais réservé,
 * ou réservation déjà libérée), déjà réservé par ce même onglet (réservation
 * idempotente), ou réservation d'un autre onglet mais périmée (antérieure à
 * `staleBefore` — un onglet mort ne doit jamais bloquer un segment
 * définitivement).
 *
 * Extrait en fonction pure et partagé par `indexeddb.ts` et `memory.ts` pour
 * que les deux implémentations ne puissent pas diverger sur cette règle : la
 * bascule multi-onglets (P3) en dépend directement.
 */
export function canClaimSegment(
  segment: Pick<Segment, "claimedBy" | "claimedAt">,
  tabId: string,
  staleBefore: number,
): boolean {
  if (segment.claimedBy === undefined || segment.claimedBy === tabId) {
    return true;
  }
  return segment.claimedAt !== undefined && segment.claimedAt < staleBefore;
}
