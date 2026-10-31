import { z } from 'zod';
import { isIP, type AddressInfo } from 'node:net';
import { buildProjectRawFileUrl } from '@open-design/contracts';
import { bearerTokenFromRequest } from '../http/tool-request-auth.js';
import type { ToolTokenRegistry } from '../tool-tokens.js';
import type { McpCredentialStore } from './credentials.js';
import { resolveMcpGrant } from './auth.js';
import { McpToolRegistry, operationAllowed, toolError, toolOk, type McpToolContext } from './registry.js';

const OPERATION = 'project/project:read';
const LIMIT = 8_000;
const TOKEN = /(?:odtt_|odmcp_)[A-Za-z0-9_-]+/;
type Project = Record<string, unknown> & { id: string; metadata?: Record<string, unknown> | null };
type Snapshot = { payload: { project: Project; resolvedDir: string }; revalidate: () => boolean };
function safeEntry(value: unknown, bearer: string | null): boolean {
  let units=0,nodes=0;
  const visit=(item:unknown,depth:number):boolean=>{
    if (++nodes>2_000 || depth>24 || ++units>LIMIT) return false;
    if (typeof item==='string') {units+=item.length;return units<=LIMIT&&!TOKEN.test(item)&&!(bearer&&item.includes(bearer));}
    if (!item || typeof item!=='object') return true;
    if (Array.isArray(item)) return item.every(child=>visit(child,depth+1));
    for(const key in item) {if(!Object.hasOwn(item,key))continue;units+=key.length;if(units>LIMIT||TOKEN.test(key)||(bearer&&key.includes(bearer))||!visit((item as Record<string,unknown>)[key],depth+1))return false;}
    return true;
  };return visit(value,0);
}
function safeEntryPath(value: unknown): value is string {
  return typeof value==='string' && value.length>0 && value.length<=4096 && !value.startsWith('/') && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(value) && value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
}

/** A wildcard listener is reachable on the loopback address of its own family. */
export function loopbackOriginFromListener(address: AddressInfo | string | null): string | null {
  if (!address || typeof address === 'string' || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) return null;
  if (address.address === '0.0.0.0') return `http://127.0.0.1:${address.port}`;
  if (address.address === '::') return `http://[::1]:${address.port}`;
  if (address.address === '::1') return `http://[::1]:${address.port}`;
  if (isIP(address.address) === 4 && address.address.startsWith('127.')) return `http://${address.address}:${address.port}`;
  return null;
}

function trustedLoopbackOrigin(origin: string | null): string | null {
  // Require a literal loopback host and the resolved listener port, rather
  // than accepting URL normalization of shorthand hosts or a default port.
  if (!origin) return null;
  const match = /^http:\/\/(?:127(?:\.\d{1,3}){3}|\[::1\]):(\d{1,5})\/?$/.exec(origin);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    const host = parsed.hostname;
    if (host !== '[::1]' && !(isIP(host) === 4 && host.startsWith('127.'))) return null;
    return parsed.origin;
  } catch { return null; }
}

export function registerUnboundProjectDetailMcpTool(registry:McpToolRegistry,deps:{
  toolTokenRegistry:ToolTokenRegistry;credentialStore:McpCredentialStore;
  readUnboundProjectDetail:(id:string)=>Promise<Snapshot|null>;
  daemonBaseUrl:()=>string|null;
}):void {
  registry.register({name:'get_project',operation:OPERATION,version:1,annotations:{readOnlyHint:true},
    description:'Get one unbound project by exact ID. Workspace-scoped, name and active-project resolution are unsupported. Entry discovery from files and studio links are unavailable.',
    schema:z.object({project:z.string().min(1).max(128),pluginWorkflowId:z.unknown().optional().describe('Unsupported by HTTP MCP.')}).strict(),
    handler:async(args,context)=>{
      if(args.pluginWorkflowId!==undefined)return toolError('UNSUPPORTED_ARGUMENT','pluginWorkflowId attribution is not supported by HTTP MCP',0);
      if(context.grant.kind!=='external'||!context.request)return toolError('PROJECT_SCOPE_DENIED','headerless external access required',0);
      if(Object.keys(context.request.headers??{}).some(k=>k.toLowerCase().startsWith('x-od-workspace-')))return toolError('WORKSPACE_SCOPE_UNSUPPORTED','workspace-scoped project access is not supported',0);
      const denied=()=>toolError('PROJECT_SCOPE_DENIED','project access denied',0);
      const current=(ctx:McpToolContext)=>{if(!ctx.request||ctx.signal?.aborted)return false;const auth=resolveMcpGrant(ctx.request,deps);return auth.ok&&auth.grant.kind==='external'&&!!auth.grant.credentialId&&auth.grant.credentialId===ctx.grant.credentialId&&operationAllowed(auth.grant.allowedOperations,OPERATION);};
      try {
        if(!current(context))return denied();
        const snapshot=await deps.readUnboundProjectDetail(args.project);
        if(!snapshot||!current(context))return denied();
        const {project,resolvedDir}=snapshot.payload;
        const declared=typeof project.metadata?.entryFile==='string'&&project.metadata.entryFile.length>0?project.metadata.entryFile:null;
        const origin=trustedLoopbackOrigin(deps.daemonBaseUrl());
        const previewUrl=origin&&safeEntryPath(declared)?buildProjectRawFileUrl(origin,project.id,declared):null;
        const data={...project,entryFile:declared,kind:project.metadata?.kind??null,resolvedDir,
          ...(previewUrl?{previewUrl,artifactRef:{projectId:project.id,entryFile:declared},previewUrlLifetime:'current_daemon_session'}:{}),
          entryFileDiscovery:declared?'declared':'unavailable',studioUrlUnavailable:true};
        const bearer=bearerTokenFromRequest(context.request)??null;
        if(!safeEntry(data,bearer)||JSON.stringify(data).length>LIMIT)return toolError('PROJECT_DETAIL_UNSAFE','Project detail is too large or cannot be returned safely',0);
        if(!current(context)||!snapshot.revalidate()||!current(context))return denied();
        return toolOk(data,0);
      }catch{return toolError('PROJECT_DETAIL_FAILED','Unable to read project detail',0);}
    },
  });
}
