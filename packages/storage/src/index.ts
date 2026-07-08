import { SupabaseStorageAdapter } from "./supabase-adapter.js";
import type { StorageAdapter } from "./adapter.js";

export * from "./adapter.js";
export * from "./supabase-adapter.js";
export * from "./zip.js";

/** Vrátí nakonfigurovaný adapter dle env (default: supabase). */
export function createStorage(): StorageAdapter {
  const backend = process.env.STORAGE_BACKEND ?? "supabase";
  switch (backend) {
    case "supabase":
      return new SupabaseStorageAdapter();
    // "minio": lze doplnit MinioStorageAdapter beze změny volajícího kódu.
    default:
      throw new Error(`Neznámý STORAGE_BACKEND: ${backend}`);
  }
}
