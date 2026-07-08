// Sdílené typy výsledků server akcí. NENÍ to "use server" modul (jinak by nešlo
// exportovat typy) — akce si tyto typy jen importují.

export interface ActionResult {
  ok: boolean;
  message?: string;
  id?: string;
  /** Relativní odkaz (např. registrační link pozvánky) k zobrazení/zkopírování. */
  link?: string;
}

export interface AuthResult {
  ok: boolean;
  message?: string;
}
