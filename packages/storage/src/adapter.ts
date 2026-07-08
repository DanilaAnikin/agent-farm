import type { Readable } from "node:stream";

/**
 * StorageAdapter — jednotné rozhraní. Výchozí impl. Supabase Storage;
 * cesta k MinIO (na farm VPS) bez zásahu do zbytku kódu.
 * Cesty: users/{user_id}/projects/{project_id}/{asset_id}.{ext}
 */
export interface StorageAdapter {
  put(path: string, data: Buffer | Uint8Array, contentType?: string): Promise<{ path: string }>;
  get(path: string): Promise<Buffer>;
  getStream(path: string): Promise<Readable>;
  getSignedUrl(path: string, expiresInSec?: number): Promise<string>;
  remove(path: string): Promise<void>;
  list(prefix: string): Promise<{ path: string; size?: number }[]>;
}

export function assetPath(input: {
  userId: string;
  projectId: string;
  assetId: string;
  ext: string;
}): string {
  return `users/${input.userId}/projects/${input.projectId}/${input.assetId}.${input.ext.replace(/^\./, "")}`;
}
