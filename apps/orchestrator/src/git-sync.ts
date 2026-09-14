import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export class RepositorySyncError extends Error {
  constructor(readonly reason: "dirty" | "detached" | "fetch_failed" | "diverged" | "fast_forward_failed" | "unavailable") {
    super(`Repository sync blocked (${reason}); local files and commits were preserved.`);
    this.name = "RepositorySyncError";
  }
}

/** Called under the caller's repo lock. Never resets, cleans or force-merges. */
export async function syncExistingRepository(path: string): Promise<"current" | "fast_forward" | "local_ahead"> {
  const git = async (args: string[]) => (await exec("git", ["-C", path, ...args], {
    timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })).stdout.trim();
  const ancestor = async (a: string, b: string) => {
    try { await git(["merge-base", "--is-ancestor", a, b]); return true; }
    catch (error) { if ((error as { code?: number }).code === 1) return false; throw error; }
  };
  try {
    // Untracked .farm, .env and dependency files remain untouched. Git's ff-only
    // checkout itself rejects an untracked collision instead of overwriting it.
    if (await git(["status", "--porcelain", "--untracked-files=no"])) throw new RepositorySyncError("dirty");
    let branch: string;
    try { branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]); }
    catch { throw new RepositorySyncError("detached"); }
    await git(["check-ref-format", "--branch", branch]);
    const upstream = `refs/remotes/origin/${branch}`;
    try { await git(["fetch", "--no-tags", "origin", `refs/heads/${branch}:${upstream}`]); }
    catch { throw new RepositorySyncError("fetch_failed"); }
    const head = await git(["rev-parse", "HEAD"]);
    const remote = await git(["rev-parse", upstream]);
    if (head === remote) return "current";
    if (await ancestor(remote, head)) return "local_ahead";
    if (!(await ancestor(head, remote))) throw new RepositorySyncError("diverged");
    try { await git(["merge", "--ff-only", upstream]); }
    catch { throw new RepositorySyncError("fast_forward_failed"); }
    return "fast_forward";
  } catch (error) {
    // git stderr can contain an authenticated remote URL. Never expose it to
    // events, retry prompts or logs, including as Error.cause.
    if (error instanceof RepositorySyncError) throw error;
    throw new RepositorySyncError("unavailable");
  }
}
