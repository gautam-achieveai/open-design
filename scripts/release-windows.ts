// Builds the Windows share bundle for this fork in one command:
//
//   node scripts/release-windows.ts [--namespace <name>] [--out <dir>] [--force]
//
// Output (default `dist/windows/`, git-ignored):
//   OpenDesign-<version>-win-x64-setup.exe     installer
//   OpenDesign-<version>-win-x64-portable.zip  no-install copy of the app
//   clipper/                                   Web Clipper, ready for "Load unpacked"
//   OpenDesign-Web-Clipper-<version>.zip       the same Clipper files, zipped
//   README.md, SHA256SUMS.txt, build-receipt.json
//
// Incremental: the receipt records a fingerprint of the source (HEAD, the
// uncommitted diff, and untracked files). A second run with the same source
// and options exits without building. When the source did change, tools-pack's
// own content-addressed cache still skips every stage whose inputs are the same.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const RECEIPT_TOOL = "scripts/release-windows.ts";
// Explorer's "Extract All" cannot write a path longer than this.
const WINDOWS_MAX_PATH = 259;

type Receipt = {
  tool: string;
  fingerprint: string;
  builtAt: string;
  git: { head: string; branch: string; dirty: boolean };
  namespace: string;
  appVersion: string;
  clipperVersion: string;
  portableZip: { entries: number; longestEntryPath: number; longestExtractFolder: number };
  files: Record<string, { bytes: number; sha256: string }>;
};

function log(message: string): void {
  process.stderr.write(`[release-windows] ${message}\n`);
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: 512 * 1024 * 1024, encoding: "buffer" });
  return stdout.toString("utf8");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false);
}

async function sourceFingerprint(namespace: string): Promise<{ fingerprint: string; head: string; branch: string; dirty: boolean }> {
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const diff = await git(["diff", "HEAD", "--binary"]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  hash.update(`namespace=${namespace}\nhead=${head}\n`);
  hash.update(diff);
  for (const file of untracked) {
    hash.update(`\nuntracked=${file}\n`);
    hash.update(await sha256File(path.join(repoRoot, file)));
  }
  return { fingerprint: hash.digest("hex"), head, branch, dirty: diff.length > 0 || untracked.length > 0 };
}

async function isUpToDate(outDir: string, fingerprint: string): Promise<boolean> {
  const receipt = await readReceipt(outDir);
  if (receipt?.fingerprint !== fingerprint) return false;
  for (const [name, file] of Object.entries(receipt.files)) {
    const info = await stat(path.join(outDir, name)).catch(() => null);
    if (info?.size !== file.bytes) return false;
  }
  return pathExists(path.join(outDir, "clipper", "manifest.json"));
}

async function readReceipt(outDir: string): Promise<Receipt | null> {
  try {
    return JSON.parse(await readFile(path.join(outDir, "build-receipt.json"), "utf8")) as Receipt;
  } catch {
    return null;
  }
}

// electron-builder downloads makensis lazily and its cache can be cleared;
// resolving NSIS_PATH restores it before tools-pack needs it.
async function ensureNsis(): Promise<void> {
  const requirePack = createRequire(path.join(repoRoot, "tools/pack/package.json"));
  const requireBuilder = createRequire(requirePack.resolve("electron-builder/package.json"));
  const { NSIS_PATH, NsisTargetOptions } = requireBuilder("app-builder-lib/out/targets/nsis/nsisUtil.js");
  NsisTargetOptions.resolve({});
  log(`makensis: ${await NSIS_PATH()}`);
}

type PackResult = { installerPath: string; portableZipPath: string; resourceRoot: string };

async function runToolsPack(namespace: string, buildDir: string): Promise<PackResult> {
  const args = ["-s", "tools-pack", "win", "build", "--to", "all", "--portable", "--namespace", namespace, "--dir", buildDir, "--json"];
  log(`pnpm ${args.join(" ")}`);
  const stdout = await new Promise<string>((resolve, reject) => {
    // pnpm is a .cmd shim on Windows, so it needs a shell; pass one quoted
    // command line rather than an args array the shell would not escape.
    const commandLine = ["pnpm", ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
    const child = spawn(commandLine, {
      cwd: repoRoot,
      shell: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`tools-pack exited with code ${code}`));
    });
  });
  await writeFile(path.join(buildDir, "tools-pack-result.json"), stdout);
  const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Partial<PackResult>;
  if (!result.installerPath || !result.portableZipPath || !result.resourceRoot) {
    throw new Error("tools-pack result is missing installerPath, portableZipPath or resourceRoot");
  }
  return result as PackResult;
}

async function listZipPaths(sevenZip: string, zipPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(sevenZip, ["l", "-slt", "-ba", zipPath], { maxBuffer: 256 * 1024 * 1024 });
  return stdout.split(/\r?\n/).filter((line) => line.startsWith("Path = ")).map((line) => line.slice(7));
}

// The bundled Clipper must be the Clipper in this checkout, not a stale copy.
async function verifyClipper(clipperDir: string): Promise<void> {
  const tracked = (await git(["ls-files", "-z", "clipper"])).split("\0").filter((file) => file && !file.startsWith("clipper/tests/"));
  const mismatched: string[] = [];
  for (const file of tracked) {
    const bundled = path.join(clipperDir, file.slice("clipper/".length));
    const source = path.join(repoRoot, file);
    if (!(await pathExists(bundled)) || (await sha256File(bundled)) !== (await sha256File(source))) mismatched.push(file);
  }
  if (mismatched.length > 0) throw new Error(`bundled Clipper differs from source: ${mismatched.join(", ")}`);
  log(`Clipper: ${tracked.length} source files match the bundled copy`);
}

function readme(receipt: Omit<Receipt, "files">, names: Record<string, string>): string {
  const { longestEntryPath, longestExtractFolder } = receipt.portableZip;
  return `# Open Design ${receipt.appVersion} for Windows

Built from \`${receipt.git.branch}\` at \`${receipt.git.head.slice(0, 10)}\`${receipt.git.dirty ? " plus uncommitted changes" : ""}.
Built on ${receipt.builtAt}. x64 only. Unsigned, so Windows SmartScreen may warn.

## Install the app (pick one)

- **Installer:** run \`${names.installer}\`.
- **Portable:** extract \`${names.portable}\` and run \`Open Design.exe\`.

### Extracting the portable zip

Some files inside are nested ${longestEntryPath} characters deep. Windows'
**Extract All** cannot write paths longer than ${WINDOWS_MAX_PATH} characters.
Its default target folder in Downloads is too long, so files go missing.

- Extract into a short folder of at most ${longestExtractFolder} characters,
  such as \`D:\\OpenDesign\`.
- Or use the built-in \`tar\`, which handles long paths when Windows long
  paths are on:
  \`tar -xf ${names.portable} -C <folder>\`
- 7-Zip also works anywhere.

## Load the Web Clipper

1. Open \`edge://extensions\` (Edge) or \`chrome://extensions\` (Chrome).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick the \`clipper\` folder next to this file.
   \`${names.clipperZip}\` holds the same files.
4. Pin **OpenDesign Web Clipper** to the toolbar.
5. In Open Design, open **Connect managed Edge → Copy connection URL**. Paste
   it into Clipper and click **Connect**.

The installed app also carries Clipper at \`resources\\open-design\\clipper\`.

See \`SHA256SUMS.txt\` and \`build-receipt.json\` for hashes and build details.
`;
}

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows packages must be built on Windows");
  const { values } = parseArgs({
    options: {
      namespace: { type: "string", default: "gb-main" },
      out: { type: "string", default: path.join(repoRoot, "dist", "windows") },
      force: { type: "boolean", default: false },
    },
  });
  const namespace = values.namespace!;
  const outDir = path.resolve(values.out!);
  const buildDir = path.join(repoRoot, ".tmp", "release-windows");

  const source = await sourceFingerprint(namespace);
  if (!values.force && (await isUpToDate(outDir, source.fingerprint))) {
    log(`up to date: ${outDir} already holds this source (${source.fingerprint.slice(0, 12)}). Use --force to rebuild.`);
    return;
  }
  const existing = await readReceipt(outDir);
  if ((await pathExists(outDir)) && (await readdir(outDir)).length > 0 && existing?.tool !== RECEIPT_TOOL) {
    throw new Error(`${outDir} has files this script did not write; pick another --out`);
  }

  await ensureNsis();
  await mkdir(buildDir, { recursive: true });
  const pack = await runToolsPack(namespace, buildDir);

  const appVersion = (JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
  const clipperVersion = (JSON.parse(await readFile(path.join(repoRoot, "clipper", "manifest.json"), "utf8")) as { version: string }).version;
  const names = {
    installer: `OpenDesign-${appVersion}-win-x64-setup.exe`,
    portable: `OpenDesign-${appVersion}-win-x64-portable.zip`,
    clipperZip: `OpenDesign-Web-Clipper-${clipperVersion}.zip`,
  };

  // Assemble next to the target and swap at the end, so a failed run never
  // leaves a half-written bundle behind.
  const stagingDir = `${outDir}.staging`;
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  log(`copying packages to ${stagingDir}`);
  await cp(pack.installerPath, path.join(stagingDir, names.installer));
  await cp(pack.portableZipPath, path.join(stagingDir, names.portable));
  await cp(path.join(pack.resourceRoot, "clipper"), path.join(stagingDir, "clipper"), { recursive: true });
  await verifyClipper(path.join(stagingDir, "clipper"));

  const sevenZip = path.join(repoRoot, "tools", "pack", "resources", "win", "7zip", "7z.exe");
  await execFileAsync(sevenZip, ["a", "-tzip", "-mx=9", names.clipperZip, "clipper"], { cwd: stagingDir });

  const portablePaths = await listZipPaths(sevenZip, path.join(stagingDir, names.portable));
  const longestEntryPath = Math.max(...portablePaths.map((entry) => entry.length));
  const receiptBase: Omit<Receipt, "files"> = {
    tool: RECEIPT_TOOL,
    fingerprint: source.fingerprint,
    builtAt: new Date().toISOString(),
    git: { head: source.head, branch: source.branch, dirty: source.dirty },
    namespace,
    appVersion,
    clipperVersion,
    portableZip: {
      entries: portablePaths.length,
      longestEntryPath,
      longestExtractFolder: WINDOWS_MAX_PATH - 1 - longestEntryPath,
    },
  };
  await writeFile(path.join(stagingDir, "README.md"), readme(receiptBase, names));

  const files: Receipt["files"] = {};
  for (const name of [names.installer, names.portable, names.clipperZip, "README.md"]) {
    const filePath = path.join(stagingDir, name);
    files[name] = { bytes: (await stat(filePath)).size, sha256: await sha256File(filePath) };
  }
  await writeFile(
    path.join(stagingDir, "SHA256SUMS.txt"),
    Object.entries(files).map(([name, file]) => `${file.sha256}  ${name}`).join("\n") + "\n",
  );
  await writeFile(path.join(stagingDir, "build-receipt.json"), `${JSON.stringify({ ...receiptBase, files }, null, 2)}\n`);

  await rm(outDir, { recursive: true, force: true });
  await rename(stagingDir, outDir);
  log(`done: ${outDir}`);
  for (const [name, file] of Object.entries(files)) log(`  ${name}  ${file.bytes} bytes  ${file.sha256.slice(0, 12)}`);
}

main().catch((error: unknown) => {
  log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
