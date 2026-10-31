import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { ToolPackCache } from "@/cache/index.js";
import type { ToolPackConfig } from "@/config/index.js";
import { prepareResourceTree } from "@/win/resources.js";
import type { WinPaths } from "@/win/types.js";

const RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS = 15_000;

async function createWorkspaceFixture(workspaceRoot: string): Promise<void> {
  await mkdir(join(workspaceRoot, "skills", "sample"), { recursive: true });
  await mkdir(join(workspaceRoot, "design-templates", "orbit-general"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "design-systems", "sample"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "craft", "sample"), { recursive: true });
  await mkdir(join(workspaceRoot, "plugins", "_official", "sample"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, "plugins", "_official", "sample", "open-design.json"),
    "{\"id\":\"sample\"}\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, "plugins", "registry", "community"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, "plugins", "registry", "community", "open-design-marketplace.json"),
    "{\"plugins\":[]}\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, "assets", "frames"), { recursive: true });
  await mkdir(join(workspaceRoot, "assets", "community-pets", "sample"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "prompt-templates", "image"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "data", "plugin-previews"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, "data", "plugin-previews", "manifest.json"),
    "{\"previews\":{}}\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, "plugins", "registry", "official"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "clipper"), { recursive: true });
  await writeFile(join(workspaceRoot, "clipper", "manifest.json"), '{"manifest_version":3}\n', "utf8");
  await writeFile(join(workspaceRoot, "clipper", "content.js"), "clipper version one\n", "utf8");
}

async function createDshRuntimeFixture(workspaceRoot: string): Promise<void> {
  const packageRoot = join(workspaceRoot, "packages", "dsh-runtime");
  await mkdir(join(packageRoot, "dist", "types"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@open-design/dsh-runtime",
      version: "0.1.0",
      files: ["dist"],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
  await writeFile(
    join(packageRoot, "dist", "types", "index.d.ts"),
    "export {};\n",
    "utf8",
  );
}

describe("prepareResourceTree", () => {
  it("replaces obsolete cloud binaries on cold and warm materialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-retired-resource-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized");
    const cache = new ToolPackCache(join(root, "cache"));
    try {
      await createWorkspaceFixture(workspaceRoot);
      for (const expectedStatus of ["miss", "hit"]) {
        const obsoleteRoot = join(resourceRoot, "bin", "libexec", "opencode");
        await mkdir(obsoleteRoot, { recursive: true });
        await writeFile(join(resourceRoot, "bin", "vela.exe"), "obsolete");
        await writeFile(join(obsoleteRoot, "opencode.exe"), "obsolete companion");
        await prepareResourceTree({ workspaceRoot } as ToolPackConfig,
          { resourceRoot } as WinPaths, cache, { materialize: true });
        await expect(readFile(join(resourceRoot, "bin", "vela.exe"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(obsoleteRoot, "opencode.exe"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(join(resourceRoot, "bin"))).toEqual(["7z.dll", "7z.exe"]);
        expect(cache.report().entries.at(-1)?.status).toBe(expectedStatus);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("ships the browser clipper and refreshes it without invalidating on unrelated build output", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-clipper-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "open-design");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;

    try {
      await createWorkspaceFixture(workspaceRoot);
      await prepareResourceTree(config, paths, cache, { materialize: true });
      await expect(readFile(join(resourceRoot, "clipper", "manifest.json"), "utf8"))
        .resolves.toBe('{"manifest_version":3}\n');
      await expect(readFile(join(resourceRoot, "clipper", "content.js"), "utf8"))
        .resolves.toBe("clipper version one\n");

      await writeFile(join(workspaceRoot, "clipper", "content.js"), "clipper version two\n", "utf8");
      await prepareResourceTree(config, paths, cache, { materialize: true });
      await expect(readFile(join(resourceRoot, "clipper", "content.js"), "utf8"))
        .resolves.toBe("clipper version two\n");

      await mkdir(join(workspaceRoot, "apps", "web", "dist"), { recursive: true });
      await writeFile(join(workspaceRoot, "apps", "web", "dist", "output.js"), "unrelated output", "utf8");
      await prepareResourceTree(config, paths, cache, { materialize: true });
      expect(cache.report().entries.map((entry) => entry.status)).toEqual(["miss", "miss", "hit"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("bundles the DeepSeek Harness runtime into the Windows resource tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-dsh-runtime-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "open-design");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;

    try {
      await createWorkspaceFixture(workspaceRoot);
      await createDshRuntimeFixture(workspaceRoot);

      await prepareResourceTree(
        config,
        paths,
        cache,
        { bundleAgentRuntimes: true, materialize: true },
        "workspace-build-dsh-v1",
      );

      const runtimeRoot = join(resourceRoot, "agent-runtimes", "deepseek-harness");
      const manifest = JSON.parse(
        await readFile(join(runtimeRoot, "manifest.json"), "utf8"),
      ) as {
        file: string;
        packageName: string;
        schemaVersion: number;
        sha256: string;
        version: string;
      };
      const tarballs = (await readdir(runtimeRoot)).filter((entry) => entry.endsWith(".tgz"));

      expect(manifest).toMatchObject({
        file: tarballs[0],
        packageName: "@open-design/dsh-runtime",
        schemaVersion: 1,
        version: "0.1.0",
      });
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(tarballs).toHaveLength(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS);

  it("invalidates the Windows resource tree cache when design templates change", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-resources-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "open-design");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const templatePath = join(
      workspaceRoot,
      "design-templates",
      "orbit-general",
      "SKILL.md",
    );
    const materializedTemplatePath = join(
      resourceRoot,
      "design-templates",
      "orbit-general",
      "SKILL.md",
    );

    try {
      await createWorkspaceFixture(workspaceRoot);
      await writeFile(templatePath, "version one\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedTemplatePath, "utf8")).resolves.toBe(
        "version one\n",
      );

      await writeFile(templatePath, "version two\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedTemplatePath, "utf8")).resolves.toBe(
        "version two\n",
      );
      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "miss",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS);

  it("invalidates the Windows resource tree cache when the plugin-preview manifest changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-previews-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "open-design");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const manifestPath = join(
      workspaceRoot,
      "data",
      "plugin-previews",
      "manifest.json",
    );
    const materializedManifestPath = join(
      resourceRoot,
      "data",
      "plugin-previews",
      "manifest.json",
    );

    try {
      await createWorkspaceFixture(workspaceRoot);
      await writeFile(manifestPath, "{\"previews\":{\"a\":1}}\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedManifestPath, "utf8")).resolves.toBe(
        "{\"previews\":{\"a\":1}}\n",
      );

      await writeFile(manifestPath, "{\"previews\":{\"a\":2}}\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedManifestPath, "utf8")).resolves.toBe(
        "{\"previews\":{\"a\":2}}\n",
      );
      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "miss",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS);
});
