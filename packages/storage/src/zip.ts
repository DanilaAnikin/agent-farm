import archiver from "archiver";
import { PassThrough, type Readable } from "node:stream";
import type { StorageAdapter } from "./adapter.js";

/**
 * Streamuje ZIP z výběru assetů (Content Library → hromadné stažení).
 * Vrací čitelný stream, který lze poslat do HTTP response.
 */
export function zipAssets(
  storage: StorageAdapter,
  entries: { path: string; nameInZip: string }[],
): Readable {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const out = new PassThrough();
  archive.pipe(out);

  (async () => {
    for (const e of entries) {
      try {
        const stream = await storage.getStream(e.path);
        archive.append(stream, { name: e.nameInZip });
      } catch (err) {
        archive.append(`chyba při čtení ${e.path}: ${String(err)}`, {
          name: `${e.nameInZip}.error.txt`,
        });
      }
    }
    await archive.finalize();
  })().catch((err) => out.destroy(err as Error));

  return out;
}
