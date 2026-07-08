/**
 * Pomocníci pro čtení povinných proměnných prostředí.
 * Když chybí klíč potřebný pro placené volání, selžeme hlasitě česky —
 * ať je jasné, co doplnit do .env (uživatel ho vyplní později).
 */

/** Vrátí hodnotu env proměnné, nebo vyhodí českou chybu s nápovědou. */
export function requireEnv(name: string, hint?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(
      `Chybí povinná proměnná prostředí ${name}.` + (hint ? ` ${hint}` : ""),
    );
  }
  return v;
}

/** Vrátí volitelnou hodnotu (nebo undefined, když není nastavená). */
export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}
