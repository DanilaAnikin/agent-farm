import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="text-5xl">◇</div>
      <h1 className="text-xl font-semibold">Stránka nenalezena</h1>
      <p className="text-sm text-(--color-muted)">Tenhle zdroj neexistuje nebo k němu nemáš přístup.</p>
      <Link
        href="/projects"
        className="inline-flex h-10 items-center rounded-lg bg-(--color-accent) px-4 text-sm font-medium text-white hover:brightness-110"
      >
        Zpět na projekty
      </Link>
    </main>
  );
}
