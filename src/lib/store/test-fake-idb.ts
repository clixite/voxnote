/**
 * Point d'entrée commun pour les tests de cette couche qui ont besoin d'une
 * vraie IndexedDB : installe `fake-indexeddb` et corrige un bug connu de
 * jsdom (https://github.com/jsdom/jsdom/issues/3363) où le `Blob` fourni par
 * l'environnement de test n'est pas reconnu par `structuredClone`, ce qui fait
 * qu'un Blob stocké revient sous forme d'objet vide (`{}`) à la lecture.
 * `idb`/`fake-indexeddb` clonent les valeurs via `structuredClone` — sans ce
 * correctif, aucun des deux ne peut donc conserver un Blob correctement dans
 * cet environnement, alors que ça fonctionne dans un vrai navigateur.
 *
 * À importer avant toute manipulation de Blob dans un test IndexedDB de ce
 * répertoire.
 */
import { Blob as NodeBlob } from "node:buffer";

import "fake-indexeddb/auto";

globalThis.Blob = NodeBlob as unknown as typeof Blob;
