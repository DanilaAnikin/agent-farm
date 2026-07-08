import clsx, { type ClassValue } from "clsx";

/** Spojení tříd (tenký wrapper nad clsx). */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
