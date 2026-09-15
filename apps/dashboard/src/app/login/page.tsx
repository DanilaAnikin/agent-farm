import { LoginForm } from "@/components/auth/LoginForm";

export const metadata = { title: "Přihlášení" };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-(--color-accent) text-xl font-bold text-white">
            ⬢
          </div>
          <h1 className="text-xl font-semibold">Perennial</h1>
          <p className="mt-1 text-sm text-(--color-muted)">
            Přístup jen na pozvánku. Přihlas se svým účtem.
          </p>
        </div>
        <LoginForm />
        <p className="mt-6 text-center text-xs text-(--color-faint)">
          Nemáš účet? Registrace probíhá jen přes pozvánku od administrátora.
        </p>
      </div>
    </main>
  );
}
