/** Match the existing stdio list_plugins projection, omitting raw storage fields. */
export function projectPluginCatalog(records: readonly unknown[]): Array<Record<string, unknown>> {
  return records.map((record) => {
    const plugin = record as Record<string, unknown> | null | undefined;
    const manifest = (plugin?.manifest as Record<string, unknown> | null | undefined) ?? {};
    const od = (manifest.od as Record<string, unknown> | null | undefined) ?? {};
    const kind = od?.taskKind ?? od?.kind;
    return {
      id: plugin?.id,
      title: manifest.title ?? plugin?.title ?? plugin?.id,
      ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
      ...(typeof kind === 'string' ? { kind } : {}),
      ...(Array.isArray(manifest.tags) ? { tags: manifest.tags } : {}),
    };
  });
}
