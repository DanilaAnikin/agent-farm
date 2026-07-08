/**
 * Pomocník pro kooperativní smyčky orchestrátoru.
 * Každá iterace běží v try/catch — jedna chyba nikdy neshodí celý proces.
 * Zastavení je kooperativní: requestStop() nastaví globální příznak a smyčky
 * po dokončení aktuální iterace samy skončí (graceful shutdown).
 */

let stopping = false;

export function requestStop(): void {
  stopping = true;
}

export function isStopping(): boolean {
  return stopping;
}

/** Spí `ms` milisekund, ale probudí se dřív, pokud přišlo zastavení. */
export async function sleep(ms: number): Promise<void> {
  const step = 250;
  let waited = 0;
  while (waited < ms && !stopping) {
    const chunk = Math.min(step, ms - waited);
    await new Promise((r) => setTimeout(r, chunk));
    waited += chunk;
  }
}

/**
 * Spustí smyčku `fn` každých `everyMs` (měřeno od začátku iterace).
 * Iterace, která vyhodí, se jen zaloguje a pokračuje se dál.
 * Vrací se, až přijde požadavek na zastavení.
 */
export async function runLoop(
  name: string,
  everyMs: number,
  fn: () => Promise<void>,
): Promise<void> {
  while (!isStopping()) {
    const start = Date.now();
    try {
      await fn();
    } catch (err) {
      console.error(`[loop:${name}] iterace selhala:`, err);
    }
    const elapsed = Date.now() - start;
    await sleep(Math.max(0, everyMs - elapsed));
  }
  console.log(`[loop:${name}] zastaveno.`);
}
