import { redirect } from "next/navigation";

// Solo self-host: žádný marketingový web. Kořen jen přesměruje do velína.
// (Middleware nepřihlášené pošle na /login, přihlášené pustí sem → /projects.)
export default function RootPage() {
  redirect("/projects");
}
