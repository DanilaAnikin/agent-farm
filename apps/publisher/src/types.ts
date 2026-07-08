/**
 * Sdílené typy Publisheru — tvary zpráv z front, credentials a payloadů.
 * Kód a identifikátory anglicky; komentáře česky.
 */

/** Zpráva ve frontě q_publish. Odkazuje na publish_requests řádek. */
export interface PublishJob {
  publishRequestId: string;
}

/** Zpráva ve frontě q_deploy — preview deploy (bez approvalu, na farm Dokploy). */
export interface DeployJob {
  projectId: string;
  wishId?: string | null;
  kind: "preview";
}

/** Instagram credentials po dešifrování connections.encrypted_credentials. */
export interface InstagramCredentials {
  /** Instagram user id (IG Business/Creator účet). */
  igUserId: string;
  /** Dlouhodobý access token. */
  accessToken: string;
}

/** Per-user Dokploy credentials (produkční deploy). */
export interface DokployCredentials {
  /** Základní URL produkčního Dokploy uživatele (https://…). */
  url: string;
  /** API klíč (x-api-key). */
  apiKey: string;
}

/** Artefakt k nasazení — buď hotový image, nebo repo+branch, které Dokploy postaví. */
export interface DeployArtifact {
  /** Docker image (pokud stavěl orchestrátor/CI). */
  image?: string;
  /** Git repo URL (pokud staví Dokploy z gitu). */
  repoUrl?: string;
  branch?: string;
  /** Doména pro health check (https://…). */
  domain?: string;
  /** Existující Dokploy application id (pokud už bylo založeno). */
  appId?: string;
  /** Volitelné env proměnné pro Dokploy aplikaci. */
  env?: Record<string, string>;
}

/** Payload approvalu typu deploy_prod. */
export interface DeployProdPayload {
  projectId: string;
  artifact?: DeployArtifact;
}
