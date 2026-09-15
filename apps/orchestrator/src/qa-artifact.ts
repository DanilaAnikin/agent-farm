/** Compose reviewed results in a disposable worktree; never change or publish main. */
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

export class QaArtifactError extends Error {
  constructor(readonly reason: string) { super(`QA artifact unavailable: ${reason}`); this.name = "QaArtifactError"; }
}
export interface ReviewedQaArtifact { taskId: string; attemptId: string; branch: string }
export interface QaArtifactProvenance { taskId: string; attemptId: string; branch: string; commit: string }
export interface QaWorkspace {
  path: string;
  commit: string;
  artifacts: QaArtifactProvenance[];
  cleanup(): Promise<void>;
}

export async function prepareQaWorkspace(input: {
  workspacesRoot: string; projectId: string; qaRunId: string;
  existing: boolean; artifacts: ReviewedQaArtifact[];
  owner?: { uid: number; gid: number };
}): Promise<QaWorkspace> {
  if (![input.projectId, input.qaRunId].every(s => /^[A-Za-z0-9_-]+$/.test(s))) throw new QaArtifactError("invalid_identity");
  const repo = join(input.workspacesRoot, input.projectId);
  const path = join(input.workspacesRoot, ".qa-worktrees", `qa-${input.qaRunId}`);
  const git = async (cwd: string, ...args: string[]) => (await execFileP("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Farm QA",
    "-c", "user.email=qa@agent-farm.local", "-C", cwd, ...args,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
  let created = false;
  const cleanup = async () => {
    if (!created) return;
    // Never accept cleanup paths from model output or database artifacts.
    if (resolve(path, "..") !== resolve(input.workspacesRoot, ".qa-worktrees")) throw new QaArtifactError("invalid_cleanup_path");
    await git(repo, "worktree", "remove", "--force", path).catch(() => undefined);
    await fs.rm(path, { recursive: true, force: true });
    await git(repo, "worktree", "prune");
    created = false;
  };
  try {
    const artifacts: QaArtifactProvenance[] = [];
    const seenTasks = new Set<string>();
    for (const item of input.artifacts) {
      if (seenTasks.has(item.taskId) || !/^[A-Za-z0-9_-]+$/.test(item.taskId)
          || !item.branch.startsWith(`farm/task-${item.taskId}`) || item.branch.includes("..")) throw new QaArtifactError("invalid_reviewed_ref");
      seenTasks.add(item.taskId);
      await git(repo, "check-ref-format", `refs/heads/${item.branch}`);
      const commit = await git(repo, "rev-parse", "--verify", `refs/heads/${item.branch}^{commit}`);
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new QaArtifactError("missing_reviewed_commit");
      artifacts.push({ ...item, commit });
    }
    if (input.existing && artifacts.length === 0) throw new QaArtifactError("missing_reviewed_artifacts");
    const start = input.existing ? artifacts[0]!.commit : await git(repo, "rev-parse", "HEAD");
    await fs.mkdir(resolve(path, ".."), { recursive: true });
    await git(repo, "worktree", "add", "--detach", path, start);
    created = true;
    if (input.existing) for (const artifact of artifacts.slice(1)) {
      try {
        // Merge only inside this disposable detached worktree. No branch ref or remote changes.
        await git(path, "merge", "--no-ff", "--no-edit", "--no-gpg-sign", artifact.commit);
      } catch { throw new QaArtifactError("approved_artifacts_conflict"); }
    }
    const commit = await git(path, "rev-parse", "HEAD");
    if (input.owner) await execFileP("chown", ["-R", `${input.owner.uid}:${input.owner.gid}`, path], { timeout: 30_000 });
    return { path, commit, artifacts, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    if (error instanceof QaArtifactError) throw error;
    // Git diagnostics can contain authenticated remotes; never expose raw stderr.
    throw new QaArtifactError("repository_or_permissions");
  }
}

/** Installation failures are harness failures, not evidence that reviewed code is wrong. */
export function qaInfrastructureFailure(run: { ok: boolean; installOk: boolean; results: unknown[]; error?: string }): string | undefined {
  if (!run.ok) return "QA runner did not finish";
  if (!run.installOk) return "QA dependency installation failed";
  if (run.results.length === 0) return "QA runner produced no scenarios";
  return undefined;
}
