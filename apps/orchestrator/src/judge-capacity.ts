/**
 * Kapacita kontejnerů třídy „judge" (JUDGE_LIMITS: 4 GiB, 1,5 jádra).
 *
 * CPU rozpočet farmy počítá s tím, že takových kontejnerů běží nejvýš
 * `judgeSlots()` (viz komentář u JUDGE_LIMITS v docker.ts: 3 workery + 2 judge
 * = 6 z 8 jader). Ten strop ale držely jen smyčky `judge-N` svým počtem —
 * kdokoliv další, kdo si takový kontejner vezme (průzkum repozitáře), rozpočet
 * potichu překročil o celý další kontejner, a to na dlouho: jedno kolo sondy je
 * až 3 × (12 min kontroly + 6 min start).
 *
 * Proto jeden společný počitadlo-semafor pro všechny, kdo tyhle kontejnery
 * spouštějí. Sloty se berou NEBLOKUJÍCÍ: kdo slot nedostane, svoje kolo prostě
 * přeskočí (soudce to zkusí za 3 s, průzkum za 10 min). Čekání ve frontě by tu
 * jen převedlo přetížení CPU na zaseknuté smyčky.
 */
import { judgeSlots } from "./runtime-config.js";

let inUse = 0;

export interface JudgeSlot {
  /** Vrátí slot. Opakované volání je bezpečné (a nic neudělá). */
  release(): void;
}

/** Vezme slot, je-li volný; jinak null (volající své kolo přeskočí). */
export function tryTakeJudgeSlot(): JudgeSlot | null {
  if (inUse >= judgeSlots()) return null;
  inUse++;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      inUse = Math.max(0, inUse - 1);
    },
  };
}

/** Kolik slotů je právě obsazených (pro diagnostiku). */
export function judgeSlotsInUse(): number {
  return inUse;
}

/** Obalí smyčku tak, že bez volného slotu své kolo vůbec nezačne. */
export function gateOnJudgeSlot(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const slot = tryTakeJudgeSlot();
    if (!slot) return;
    try {
      await fn();
    } finally {
      slot.release();
    }
  };
}
