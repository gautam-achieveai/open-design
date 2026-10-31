import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hashJson, hashPath, ToolPackCache } from "../cache/index.js";
import type { ToolPackConfig } from "../config/index.js";
import {
  BUNDLED_RESOURCE_TREES,
  copyBundledResourceTrees,
  packBundledDshRuntime,
  winResources,
} from "../resources/index.js";
import type { WinPaths, ResourceTreeCacheMetadata } from "./types.js";

const RESOURCE_TREE_CACHE_SCHEMA_VERSION = 9;

async function createResourceTreeCacheKey(
  config: ToolPackConfig,
  workspaceBuildKey: string,
  bundleAgentRuntimes: boolean,
): Promise<string> {
  return hashJson({
    bundledResources: await Promise.all(BUNDLED_RESOURCE_TREES.map(async ({ from, to }) => ({
      from,
      to,
      hash: await hashPath(join(config.workspaceRoot, from)),
    }))),
    bundleAgentRuntimes,
    clipper: await hashPath(join(config.workspaceRoot, "clipper")),
    node: "win.resource-tree",
    schemaVersion: RESOURCE_TREE_CACHE_SCHEMA_VERSION,
    sevenZipDll: await hashPath(winResources.sevenZipDll),
    sevenZipExe: await hashPath(winResources.sevenZipExe),
    workspaceBuildKey,
  });
}

export type ResourceTreeResult = {
  key: string;
  resourceRoot: string;
};

export async function prepareResourceTree(
  config: ToolPackConfig,
  paths: WinPaths,
  cache: ToolPackCache,
  options: { bundleAgentRuntimes?: boolean; materialize: boolean },
  workspaceBuildKey = "workspace-build-not-provided",
): Promise<ResourceTreeResult> {
  const key = await createResourceTreeCacheKey(
    config,
    workspaceBuildKey,
    options.bundleAgentRuntimes === true,
  );
  const node = {
    id: "win.resource-tree",
    key,
    outputs: ["open-design"],
    invalidate: async () => null,
    build: async ({ entryRoot }: { entryRoot: string }): Promise<ResourceTreeCacheMetadata> => {
      const resourceRoot = join(entryRoot, "open-design");
      await mkdir(resourceRoot, { recursive: true });
      await copyBundledResourceTrees({
        workspaceRoot: config.workspaceRoot,
        resourceRoot,
      });
      await cp(join(config.workspaceRoot, "clipper"), join(resourceRoot, "clipper"), {
        recursive: true,
      });
      if (options.bundleAgentRuntimes === true) {
        await packBundledDshRuntime({
          workspaceRoot: config.workspaceRoot,
          resourceRoot,
        });
      }
      await mkdir(join(resourceRoot, "bin"), { recursive: true });
      await cp(winResources.sevenZipExe, join(resourceRoot, "bin", "7z.exe"));
      await cp(winResources.sevenZipDll, join(resourceRoot, "bin", "7z.dll"));
      return { resourceName: "open-design" };
    },
  };
  const manifest = await cache.acquire({
    materialize: options.materialize ? [{ from: "open-design", to: paths.resourceRoot }] : [],
    node,
  });
  return {
    key,
    resourceRoot: options.materialize ? paths.resourceRoot : join(manifest.entryPath, "open-design"),
  };
}

export async function copyWinIcon(paths: WinPaths): Promise<void> {
  await mkdir(dirname(paths.winIconPath), { recursive: true });
  await cp(winResources.icon, paths.winIconPath);
}
