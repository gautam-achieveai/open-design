import { toolOk } from './registry.js';

/**
 * Measure both MCP representations as UTF-8 JSON. The registry replaces `ms`
 * after the handler returns, so use a large finite value and include the
 * actual tool version. Callers must reserve room for later metadata changes.
 */
export function toolOkFitsUtf8Bytes(data: unknown, truncated: boolean, version: number, maxBytes: number): boolean {
  const result = toolOk(data, -Number.MAX_VALUE, truncated ? { truncated: true } : undefined);
  result.structuredContent.meta.toolVersion = version;
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes;
}
