/** Read-only Git metadata for one worker; original worktree and credentials stay private. */
import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
const CONTAINER_GIT = "/opt/farm-git";

export interface WorkerGitView { directory: string; binds: string[] }

export async function prepareWorkerGitView(
  workspacesRoot: string, projectId: string, workspacePath: string,
): Promise<WorkerGitView> {
  let directory: string | undefined;
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error();
    const runGit = async (...args: string[]) => (await execFileP("git", ["-C", workspacePath, ...args], {
      timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    })).stdout.trim();
    const common = await fs.realpath(resolve(workspacePath, await runGit("rev-parse", "--git-common-dir")));
    const expected = await fs.realpath(join(workspacesRoot, projectId, ".git"));
    if (common !== expected) throw new Error();
    const gitDir = await runGit("rev-parse", "--absolute-git-dir");
    const commit = await runGit("rev-parse", "HEAD");
    const ref = await runGit("symbolic-ref", "--quiet", "HEAD").catch(() => "");
    if (!/^[a-f0-9]{40,64}$/.test(commit) || (ref && (!ref.startsWith("refs/heads/") || ref.includes("..")))) throw new Error();
    const parent = join(workspacesRoot, ".git-views");
    await fs.mkdir(parent, { recursive: true });
    directory = await fs.mkdtemp(join(parent, "worker-"));
    // mkdtemp is 0700; worker UID 1001 must be able to read the sanitized view.
    await fs.chmod(directory, 0o755);
    const metadata = join(directory, "metadata");
    await fs.mkdir(join(metadata, "objects"), { recursive: true });
    await fs.mkdir(join(metadata, "refs", "heads"), { recursive: true });
    await fs.writeFile(join(metadata, "config"), "[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = false\n");
    await fs.writeFile(join(metadata, "HEAD"), ref ? `ref: ${ref}\n` : `${commit}\n`);
    if (ref) { const target = join(metadata, ref); await fs.mkdir(resolve(target, ".."), { recursive: true }); await fs.writeFile(target, `${commit}\n`); }
    await fs.copyFile(join(gitDir, "index"), join(metadata, "index"));
    // Preserve split-index repositories without sharing any other worktree metadata.
    for (const name of await fs.readdir(gitDir)) if (/^sharedindex\.[a-f0-9]+$/.test(name)) await fs.copyFile(join(gitDir, name), join(metadata, name));
    const link = join(directory, "gitfile");
    await fs.writeFile(link, `gitdir: ${CONTAINER_GIT}\n`);
    return { directory, binds: [
      `${metadata}:${CONTAINER_GIT}:ro`,
      `${join(common, "objects")}:${CONTAINER_GIT}/objects:ro`,
      `${link}:/workspace/.git:ro`,
    ] };
  } catch {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("Worker Git metadata preparation failed; original repository was preserved");
  }
}

/** Only remove our own generated directories, never arbitrary container labels. */
export async function removeWorkerGitView(workspacesRoot: string, directory?: string): Promise<void> {
  if (!directory || !/^worker-[A-Za-z0-9]+$/.test(basename(directory))
      || resolve(directory, "..") !== resolve(workspacesRoot, ".git-views")) return;
  await fs.rm(directory, { recursive: true, force: true });
}
