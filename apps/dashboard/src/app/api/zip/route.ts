import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";
import { createStorage, zipAssets } from "@farm/storage";
import { createClient } from "@/lib/supabase/server";

// Streamování ZIP z výběru assetů. Node runtime kvůli streamům a service-role storage.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 500);
}

export async function POST(request: NextRequest): Promise<Response> {
  // 1) Autentizace uživatele (server supabase, RLS pod jeho JWT).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Nepřihlášeno." }, { status: 401 });
  }

  // 2) Načíst ID výběru (form field "ids" nebo JSON body).
  let ids: string[] = [];
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as { ids?: string[] } | null;
    ids = Array.isArray(body?.ids) ? body!.ids.slice(0, 500) : [];
  } else {
    const form = await request.formData();
    ids = parseIds(String(form.get("ids") ?? ""));
  }
  if (ids.length === 0) {
    return NextResponse.json({ error: "Prázdný výběr." }, { status: 400 });
  }

  // 3) Autorizace: dotaz pod JWT uživatele → RLS vrátí jen jeho assety.
  const { data: assetsData, error } = await supabase
    .from("media_assets")
    .select("id, storage_path, kind, mime")
    .in("id", ids);
  if (error) {
    return NextResponse.json({ error: "Načtení assetů selhalo." }, { status: 500 });
  }
  const assets = (assetsData as { id: string; storage_path: string | null; kind: string; mime: string | null }[] | null) ?? [];
  const entries = assets
    .filter((a) => a.storage_path)
    .map((a) => {
      const path = a.storage_path as string;
      const base = path.split("/").pop() ?? `${a.id}`;
      return { path, nameInZip: `${a.kind}/${base}` };
    });

  if (entries.length === 0) {
    return NextResponse.json({ error: "Vybrané assety nemají soubory." }, { status: 400 });
  }

  // 4) Stream ZIP přes service-role storage (jen na serveru, po ověření vlastnictví).
  const storage = createStorage();
  const nodeStream = zipAssets(storage, entries);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

  const filename = `agentfarm-knihovna-${new Date().toISOString().slice(0, 10)}.zip`;
  return new Response(webStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
