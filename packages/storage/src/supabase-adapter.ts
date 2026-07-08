import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Readable } from "node:stream";
import type { StorageAdapter } from "./adapter.js";

export interface SupabaseStorageOptions {
  bucket?: string;
  url?: string;
  serviceRoleKey?: string;
}

export class SupabaseStorageAdapter implements StorageAdapter {
  private client: SupabaseClient;
  private bucket: string;

  constructor(opts: SupabaseStorageOptions = {}) {
    const url = opts.url ?? process.env.SUPABASE_URL;
    const key = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nejsou nastavené.");
    }
    this.client = createClient(url, key, { auth: { persistSession: false } });
    this.bucket = opts.bucket ?? "media";
  }

  async put(path: string, data: Buffer | Uint8Array, contentType?: string) {
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(path, data, { contentType, upsert: true });
    if (error) throw error;
    return { path };
  }

  async get(path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(this.bucket).download(path);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }

  async getStream(path: string): Promise<Readable> {
    const buf = await this.get(path);
    return Readable.from(buf);
  }

  async getSignedUrl(path: string, expiresInSec = 86400): Promise<string> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(path, expiresInSec);
    if (error) throw error;
    return data.signedUrl;
  }

  async remove(path: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([path]);
    if (error) throw error;
  }

  async list(prefix: string): Promise<{ path: string; size?: number }[]> {
    const { data, error } = await this.client.storage.from(this.bucket).list(prefix, {
      limit: 1000,
    });
    if (error) throw error;
    return (data ?? []).map((f) => ({
      path: `${prefix}/${f.name}`,
      size: (f.metadata as { size?: number } | null)?.size,
    }));
  }

  /** Zajistí existenci bucketu (privátní). Volá se při bootstrapu. */
  async ensureBucket(): Promise<void> {
    const { data } = await this.client.storage.getBucket(this.bucket);
    if (!data) {
      await this.client.storage.createBucket(this.bucket, { public: false });
    }
  }
}
