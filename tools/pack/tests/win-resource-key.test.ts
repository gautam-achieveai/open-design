import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolPackCache } from "@/cache/index.js";
import type { ToolPackConfig } from "@/config/index.js";
import { BUNDLED_RESOURCE_TREES, winResources } from "@/resources/index.js";
import { prepareResourceTree } from "@/win/resources.js";
import type { WinPaths } from "@/win/types.js";

const hashes = vi.hoisted(() => new Map<string, string>());
vi.mock("@/cache/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/cache/index.js")>(),
  hashPath: async (path: string) => hashes.get(path) ?? "original",
}));

describe("Windows resource cache determinants", () => {
  const workspaceRoot = join("fixture", "workspace");
  const config = { workspaceRoot } as ToolPackConfig;
  const paths = { resourceRoot: join("fixture", "output") } as WinPaths;
  const inputs = [
    ...BUNDLED_RESOURCE_TREES.map(({ from }) => join(workspaceRoot, from)),
    join(workspaceRoot, "clipper"),
    winResources.sevenZipDll,
    winResources.sevenZipExe,
  ];

  beforeEach(() => hashes.clear());

  async function key(workspaceBuildKey = "build-a", bundleAgentRuntimes = false) {
    // Key-only witness: no filesystem copies or package construction are needed.
    const cache = new ToolPackCache(join("fixture", "cache"));
    vi.spyOn(cache, "acquire").mockResolvedValue({ entryPath: "unused" } as never);
    return (await prepareResourceTree(config, paths, cache, {
      materialize: false,
      bundleAgentRuntimes,
    }, workspaceBuildKey)).key;
  }

  it.each(inputs)("invalidates when %s changes", async (path) => {
    const original = await key();
    hashes.set(path, "changed");
    expect(await key()).not.toBe(original);
  });

  it("tracks the upstream build and optional DSH output without hashing generated dist", async () => {
    const original = await key();
    expect(await key("build-b")).not.toBe(original);
    expect(await key("build-a", true)).not.toBe(original);
    hashes.set(join(workspaceRoot, "apps", "daemon", "dist"), "changed");
    expect(await key()).toBe(original);
  });
});
