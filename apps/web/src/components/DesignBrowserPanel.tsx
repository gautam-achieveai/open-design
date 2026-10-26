import { createPopupBrowserSurface } from './browser-popup-surface';
import { getHostBrowserPopups, type OpenDesignHostBrowserPopup } from '@open-design/host';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  clearHostBrowserData,
  isOpenDesignHostAvailable,
} from '@open-design/host';
import type { TrackingReferenceBoardCategory } from '@open-design/contracts/analytics';
import type { JsonValue } from '@open-design/contracts';
import { isBrowserStylePatch } from '@open-design/contracts';
import { useAnalytics } from '../analytics/provider';
import {
  trackReferenceBoardClick,
  trackReferenceBoardSurfaceView,
} from '../analytics/events';
import {
  openExternalUrl,
  projectRawUrl,
  writeProjectBase64File,
  writeProjectTextFile,
} from '../providers/registry';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import {
  type CommentSendResult,
} from './comment-send-result';
import {
  registerBrandBrowser,
  type BrandBrowserHandle,
  type BrandBrowserPageSnapshotResult,
} from '../runtime/brand-browser-bridge';
import {
  createEmbeddedBrowserControlSession,
  executeEmbeddedBrowserOperation,
  readBrowserControlMetadata,
  withBrowserControlMetadata,
  type EmbeddedBrowserControlSession,
  type EmbeddedBrowserControlSessionOptions,
  type EmbeddedBrowserControlStatus,
  type EmbeddedBrowserTarget,
} from '../runtime/embedded-browser-control';
import { captureHostRegionSnapshot, type PreviewSnapshot } from '../runtime/exports';
import type {
  ChatAttachment,
  ChatCommentAttachment,
  PreviewAnnotationStyle,
  PreviewComment,
  PreviewCommentTarget,
} from '../types';
import {
  BROWSER_VIEWPORT_PRESETS,
  BROWSER_CANCEL_PICKER_SCRIPT,
  BROWSER_CAPTURE_PAGE_ARCHIVE_SCRIPT,
  BROWSER_PAGE_ARCHIVE_INDEX_FILE,
  BROWSER_PAGE_ARCHIVE_SCHEMA,
  BROWSER_SERIALIZE_HTML_SCRIPT,
  type BrowserPageArchiveCapture,
  type BrowserPageArchiveManifest,
  type BrowserElementSnapshot,
  type BrowserMeasureTargetRequest,
  type BrowserViewportId,
  browserApplyStylesScript,
  browserApplyTextScript,
  browserCommentFilePath,
  browserElementPickerScript,
  browserAnnotationPixelMasks,
  pinCaptureFrame,
  pinCaptureTrim,
  browserAnnotationTextPaintScript,
  browserMeasureTargetsScript,
  browserSnapshotFromUnknown,
  isProjectHtmlBrowserUrl,
  projectRelativePathFromBrowserUrl,
} from './design-browser-tools';
import {
  DESIGN_BROWSER_HISTORY_LIMIT,
  loadBrowserViewport,
  loadHistory,
  saveBrowserViewport,
  saveHistory,
  type BrowserHistoryEntry,
} from './design-browser-storage';
import { Icon } from './Icon';
import { BoardComposerPopover } from './BoardComposerPopover';
import { CommentSideDock } from './FileViewer';
import { EdgeAnnotationsPanel } from './EdgeAnnotationsPanel';
import { PreviewDrawOverlay } from './PreviewDrawOverlay';
import { RemixIcon } from './RemixIcon';
import { CustomSelect } from './CustomSelect';
import { useProjectCollabContext } from '../collab/collab-context';
import { workspaceProjectHeaders } from '../collab/workspace-identity';

export {
  removeDesignBrowserProjectCache,
  designBrowserHistoryStorageKey,
  designBrowserViewportStorageKey,
  isHistoryEntry,
  loadBrowserViewport,
  loadHistory,
  saveBrowserViewport,
  saveHistory,
  type BrowserHistoryEntry,
} from './design-browser-storage';

type BrowserNavigationEntry = {
  title: string;
  url: string;
};

type ReferenceSite = {
  label: string;
  url: string;
  detail: string;
};

type ReferenceGroup = {
  /** Stable key used for the category filter (lowercase, no spaces). */
  id: string;
  title: string;
  sites: ReferenceSite[];
};

export type BrowserUseCategoryId =
  | 'assets'
  | 'tokens'
  | 'motion'
  | 'visual'
  | 'structure'
  | 'project'
  | 'general';

export interface BrowserUseAction {
  id: string;
  label: string;
  input: string;
  output: string;
  prompt: string;
}

export interface BrowserUseCategory {
  id: BrowserUseCategoryId;
  title: string;
  titleKey: keyof Dict;
  searchTerms?: string[];
  actions: BrowserUseAction[];
}

const BROWSER_USE_INPUT_KEYS: Record<string, keyof Dict> = {
  none: 'browserUse.input.none',
  'kind: images|svgs|media|fonts, limit=200': 'browserUse.input.assetKind',
  'optional selector': 'browserUse.input.optionalSelector',
  'requirement, selector? optional': 'browserUse.input.requirementSelector',
  'selector? optional': 'browserUse.input.selectorOptional',
  'scale=1': 'browserUse.input.scaleOne',
  'selector, scale=2': 'browserUse.input.selectorScaleTwo',
  'columns=12, maxWidth=1200, gap=24': 'browserUse.input.gridOverlay',
  "selector='body'": 'browserUse.input.bodySelector',
  'url / domain / search terms': 'browserUse.input.navigate',
  selector: 'browserUse.input.selector',
  'selector, text': 'browserUse.input.selectorText',
  'pixels / top / bottom / page': 'browserUse.input.scroll',
  'command, timeoutMs=120000': 'browserUse.input.terminalRun',
  command: 'browserUse.input.command',
  'maxChars=8000': 'browserUse.input.maxChars',
};

function browserUseActionOutputKey(action: BrowserUseAction): keyof Dict {
  return `browserUse.action.${action.id}.output` as keyof Dict;
}

function browserUseActionInputKey(action: BrowserUseAction): keyof Dict {
  return BROWSER_USE_INPUT_KEYS[action.input] ?? 'browserUse.input.custom';
}

function localizedBrowserUseInput(
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string,
  action: BrowserUseAction,
): string {
  const key = browserUseActionInputKey(action);
  return key === 'browserUse.input.custom' ? t(key, { input: action.input }) : t(key);
}

export interface BrowserUsePromptContext {
  browserFilePath?: string;
  projectId?: string;
  resolvedDir?: string | null;
  tabLabel?: string;
  title?: string;
  url?: string;
}

type PageBrief = {
  title?: string;
  url?: string;
  description?: string;
  headings?: string[];
  images?: string[];
  links?: { text: string; url: string }[];
  colors?: { value: string; count: number }[];
};

type BrowserTool = 'comment' | 'inspect' | 'edit';
type BrowserSavingAction = 'archive' | 'brief' | 'screenshot';
type BrowserDiagnosticNetworkEntry = {
  failed?: boolean;
  method?: string;
  requestId?: string;
  responseStatus?: number;
  url?: string;
};
type BrowserDiagnosticConsoleEntry = {
  level?: string;
  text?: string;
};
type BrowserDiagnostics = {
  consoleEntries: BrowserDiagnosticConsoleEntry[];
  networkEntries: BrowserDiagnosticNetworkEntry[];
};

function isBrowserDiagnosticNetworkEntry(value: unknown): value is BrowserDiagnosticNetworkEntry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBrowserDiagnosticConsoleEntry(value: unknown): value is BrowserDiagnosticConsoleEntry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function browserDiagnosticUrlLabel(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return value;
  }
}

type BrowserStatusMessage = string | {
  actionFileName?: string;
  actionLabel?: string;
  actionTarget?: 'design-files' | 'file';
  message: string;
  source?: 'page-snapshot';
};
export interface BrowserPageSnapshotToastEvent {
  actionFileName?: string;
  actionLabel?: string;
  actionTarget?: 'design-files' | 'file';
  elapsedSeconds?: number;
  message: string;
  onCancel?: () => void;
  status: 'loading' | 'success' | 'error' | 'canceled';
  tabId: string;
  ttlMs?: number;
}
type BrowserStyleDraft = Required<Pick<
  PreviewAnnotationStyle,
  'backgroundColor' | 'borderRadius' | 'color' | 'fontSize' | 'fontWeight' | 'lineHeight' | 'paddingTop' | 'textAlign'
>>;

type WebviewElement = HTMLElement & {
  canGoBack(): boolean;
  canGoForward(): boolean;
  capturePage(): Promise<{ toDataURL(): string }>;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  getTitle(): string;
  getURL(): string;
  getWebContentsId(): number;
  goBack(): void;
  goForward(): void;
  isLoading(): boolean;
  loadURL?(url: string): void | Promise<void>;
  reload(): void;
  reloadIgnoringCache(): void;
  stop?(): void;
};

type WebviewNavigationEvent = Event & {
  isMainFrame?: boolean;
  url?: string;
};

type WebviewTitleEvent = Event & {
  explicitSet?: boolean;
  title?: string;
};

type WebviewFaviconEvent = Event & {
  favicons?: string[];
};

type WebviewConsoleMessageEvent = Event & {
  message?: string;
};

function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
  );
}

function isBenignWebviewLoadAbort(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return /\bERR_ABORTED\b|loading ['"][^'"]+['"] was aborted/i.test(message);
}

interface DesignBrowserPanelProps {
  popup?: OpenDesignHostBrowserPopup;
  onBrowserRetentionChange?: (tabId: string, pending: boolean) => void;
  initialIconUrl?: string;
  initialTitle?: string;
  initialUrl?: string;
  navigateRequest?: { url: string; nonce: number };
  attentionRequest?: { action: 'download-page'; nonce: number };
  projectId: string;
  conversationId?: string | null;
  resolvedDir?: string | null;
  onOpenFile: (name: string) => void;
  onOpenDesignFiles?: () => void;
  onRefreshFiles: () => Promise<void> | void;
  onPageInfoChange?: (info: BrowserPageInfo) => void;
  previewComments?: PreviewComment[];
  onSavePreviewComment?: (target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images?: File[], commentId?: string) => Promise<PreviewComment | null>;
  onRemovePreviewComment?: (commentId: string) => Promise<boolean>;
  onSendBoardCommentAttachments?: (attachments: ChatCommentAttachment[], images?: File[]) => Promise<CommentSendResult> | CommentSendResult;
  /** Side-dock "Send to chat": stages the selected saved pins into the
   *  composer draft as numbered chips. Nothing is queued or deleted. */
  onStagePreviewComments?: (comments: PreviewComment[]) => void;
  onAddImageToChat?: (attachment: ChatAttachment) => void;
  onRequestBrowserUsePrompt?: (prompt: string) => void;
  onPageSnapshotToast?: (event: BrowserPageSnapshotToastEvent) => void;
  sendDisabled?: boolean;
  /** Workspace tab id. When set, this panel registers its live webview in the
   *  brand-browser bridge so the chat can read the rendered DOM (e.g. to
   *  re-extract a brand after the user clears an anti-bot wall). */
  browserTabId?: string;
  browserTabActive?: boolean;
}

export interface BrowserPageInfo {
  iconUrl?: string;
  title: string;
  url: string;
}

const EMPTY_URL = 'about:blank';
const DESIGN_BROWSER_PARTITION = 'persist:open-design-design-browser';
// Electron reads this at guest attachment, before React calls the ref. Use a
// string attribute: React omits unknown boolean attributes such as allowpopups.
const DESIGN_BROWSER_POPUP_ATTRIBUTES: Record<string, string> = { allowpopups: 'true' };
const HISTORY_LIMIT = DESIGN_BROWSER_HISTORY_LIMIT;
const HISTORY_SUGGESTION_LIMIT = 20;
const EMPTY_PREVIEW_COMMENTS: PreviewComment[] = [];
// Cap the resource-hint (`dns-prefetch`/`preconnect`) links we leave in <head>.
// Hovering/typing origins used to accumulate them and their Set entries forever.
const WARMED_ORIGIN_LIMIT = 32;
const warmedOrigins = new Map<string, HTMLLinkElement[]>();

function browserHomeNavigationEntry(): BrowserNavigationEntry {
  return { title: 'Reference Board', url: EMPTY_URL };
}

function referenceGroupTitleKey(group: ReferenceGroup): keyof Dict {
  return `designBrowser.reference.group.${group.id}` as keyof Dict;
}

function referenceSiteDetailKey(site: ReferenceSite): keyof Dict {
  return `designBrowser.reference.site.${referenceSiteId(site.url)}.detail` as keyof Dict;
}

function localizedReferenceGroupTitle(
  group: ReferenceGroup,
  t?: (key: keyof Dict) => string,
): string {
  return t ? t(referenceGroupTitleKey(group)) : group.title;
}

function localizedReferenceSiteDetail(
  site: ReferenceSite,
  t?: (key: keyof Dict) => string,
): string {
  return t ? t(referenceSiteDetailKey(site)) : site.detail;
}

function initialBrowserState(initialUrl?: string, initialTitle?: string): {
  addressValue: string;
  navigationIndex: number;
  navigationStack: BrowserNavigationEntry[];
  url: string;
} {
  const url = initialUrl?.trim() && isHistoryUrl(initialUrl.trim())
    ? initialUrl.trim()
    : EMPTY_URL;
  if (url === EMPTY_URL) {
    return {
      addressValue: '',
      navigationIndex: 0,
      navigationStack: [browserHomeNavigationEntry()],
      url,
    };
  }
  const title = initialTitle?.trim() || labelFromUrl(url);
  return {
    addressValue: url,
    navigationIndex: 0,
    navigationStack: [{ title, url }],
    url,
  };
}

// The Reference Board catalogue. Order is intentional: the categories a working
// designer reaches for most often (inspiration, real product UI) lead, followed
// by motion/color/type/asset references, then systems/guidelines/tooling.
// Adding a group here automatically adds its filter chip and address-bar
// suggestions — `id` is the stable filter key, `title` is the display label.
export const REFERENCE_GROUPS: ReferenceGroup[] = [
  {
    id: 'inspiration',
    title: 'Inspiration',
    sites: [
      { label: 'Dribbble', url: 'https://dribbble.com/', detail: 'Design shots and UI inspiration.' },
      { label: 'Behance', url: 'https://www.behance.net/', detail: 'Creative portfolios and case studies.' },
      { label: 'Awwwards', url: 'https://www.awwwards.com/', detail: 'Award-winning website design.' },
      { label: 'Godly', url: 'https://godly.website/', detail: 'Curated modern web design.' },
      { label: 'Land-book', url: 'https://land-book.com/', detail: 'Landing page gallery and patterns.' },
    ],
  },
  {
    id: 'interfaces',
    title: 'Real Interfaces',
    sites: [
      { label: 'Mobbin', url: 'https://mobbin.com/', detail: 'Real app screens and UI patterns.' },
      { label: 'Screenlane', url: 'https://screenlane.com/', detail: 'Latest UI design patterns from apps.' },
      { label: 'Page Flows', url: 'https://pageflows.com/', detail: 'Real product user flows and onboarding.' },
      { label: 'UI Sources', url: 'https://www.uisources.com/', detail: 'Interaction patterns from top apps.' },
      { label: 'Collect UI', url: 'https://collectui.com/', detail: 'Daily UI collection by category.' },
    ],
  },
  {
    id: 'motion',
    title: 'Motion',
    sites: [
      { label: 'GSAP', url: 'https://gsap.com/', detail: 'Production animation engine and examples.' },
      { label: 'Animations.dev', url: 'https://animations.dev/', detail: 'Animation patterns and interaction examples.' },
      { label: 'Transitions', url: 'https://transitions.dev/', detail: 'Transition patterns for modern interfaces.' },
      { label: 'Motion Sites', url: 'https://motionsites.ai/', detail: 'High-end motion and interaction references.' },
      { label: 'Motion.page Showcase', url: 'https://motion.page/showcase/', detail: 'Scroll and timeline animation inspiration.' },
      { label: 'Animography', url: 'https://animography.net/', detail: 'Animated type and kinetic lettering.' },
      { label: 'React Bits Shiny Text', url: 'https://reactbits.dev/text-animations/shiny-text', detail: 'React text animation reference for shiny kinetic type.' },
    ],
  },
  {
    id: 'color',
    title: 'Color',
    sites: [
      { label: 'Coolors', url: 'https://coolors.co/', detail: 'Fast color palette generator.' },
      { label: 'Color Hunt', url: 'https://colorhunt.co/', detail: 'Curated color palettes.' },
      { label: 'Realtime Colors', url: 'https://www.realtimecolors.com/', detail: 'Preview palettes on a real UI.' },
      { label: 'Adobe Color', url: 'https://color.adobe.com/', detail: 'Color wheel and harmony rules.' },
      { label: 'Happy Hues', url: 'https://www.happyhues.co/', detail: 'Palettes shown in real context.' },
    ],
  },
  {
    id: 'type',
    title: 'Typography',
    sites: [
      { label: 'Google Fonts', url: 'https://fonts.google.com/', detail: 'Open-source font library.' },
      { label: 'Fontshare', url: 'https://www.fontshare.com/', detail: 'Quality fonts free for commercial use.' },
      { label: 'Typewolf', url: 'https://www.typewolf.com/', detail: 'Fonts in use and pairing guidance.' },
      { label: 'Fontpair', url: 'https://www.fontpair.co/', detail: 'Font pairing suggestions.' },
      { label: 'Fonts In Use', url: 'https://fontsinuse.com/', detail: 'Typography in real-world design.' },
    ],
  },
  {
    id: 'icons',
    title: 'Icons',
    sites: [
      { label: 'The SVG', url: 'https://thesvg.org/', detail: 'SVG assets and vector references.' },
      { label: 'SVG Logos', url: 'https://svglogos.dev/', detail: 'Clean SVG logos for product and brand mocks.' },
      { label: 'Lobe Icons', url: 'https://icons.lobehub.com/', detail: 'Product and AI-brand icons for interfaces.' },
      { label: 'Iconify', url: 'https://icon-sets.iconify.design/', detail: '200k+ open-source icons in one place.' },
      { label: 'Lucide', url: 'https://lucide.dev/', detail: 'Clean, consistent open icon set.' },
      { label: 'Heroicons', url: 'https://heroicons.com/', detail: 'Tailwind-made SVG icons.' },
      { label: 'SVG Repo', url: 'https://www.svgrepo.com/', detail: 'Free SVG vectors and icons.' },
    ],
  },
  {
    id: 'illustration',
    title: 'Illustration',
    sites: [
      { label: 'Storyset', url: 'https://storyset.com/', detail: 'Customizable vector illustrations.' },
      { label: 'unDraw', url: 'https://undraw.co/', detail: 'Open-source MIT illustrations.' },
      { label: 'Blush', url: 'https://blush.design/', detail: 'Mix-and-match illustrations.' },
      { label: 'Lummi', url: 'https://www.lummi.ai/', detail: 'Free AI-generated visuals.' },
      { label: 'Whirrls', url: 'https://www.whirrls.com/', detail: 'Hand-drawn image references.' },
      { label: 'World in Dots', url: 'https://www.worldindots.com/', detail: 'Dot-map and data-viz references.' },
    ],
  },
  {
    id: 'photography',
    title: 'Photography',
    sites: [
      { label: 'Unsplash', url: 'https://unsplash.com/', detail: 'Free high-resolution photos.' },
      { label: 'Pexels', url: 'https://www.pexels.com/', detail: 'Free stock photos and video.' },
      { label: 'Pixabay', url: 'https://pixabay.com/', detail: 'Royalty-free images and media.' },
      { label: 'Cosmos', url: 'https://www.cosmos.so/', detail: 'Visual discovery and mood boards.' },
    ],
  },
  {
    id: '3d',
    title: '3D & Graphics',
    sites: [
      { label: 'Spline', url: 'https://spline.design/', detail: 'Browser-based 3D design.' },
      { label: 'Three.js Examples', url: 'https://threejs.org/examples/', detail: 'WebGL 3D references and demos.' },
      { label: 'Womp', url: 'https://womp.com/', detail: 'Easy in-browser 3D creation.' },
      { label: 'Pixcap', url: 'https://pixcap.com/', detail: '3D icons, mockups, and scenes.' },
    ],
  },
  {
    id: 'mockups',
    title: 'Mockups',
    sites: [
      { label: 'Shots', url: 'https://shots.so/', detail: 'Device and browser mockups.' },
      { label: 'Mockuuups Studio', url: 'https://mockuuups.studio/', detail: 'Drag-and-drop device mockups.' },
      { label: 'Angle', url: 'https://angle.sh/', detail: '3D device mockup library.' },
      { label: 'Rotato', url: 'https://rotato.app/', detail: 'Animated 3D product mockups.' },
    ],
  },
  {
    id: 'systems',
    title: 'Design Systems',
    sites: [
      { label: 'Impeccable Style', url: 'https://impeccable.style/', detail: 'High-quality style and interface references.' },
      { label: 'Styles Refero', url: 'https://styles.refero.design/', detail: 'Design style references and visual systems.' },
      { label: 'Brandfetch', url: 'https://brandfetch.com/', detail: 'Brand assets, logos, and identity.' },
      { label: 'Design Systems Repo', url: 'https://designsystemsrepo.com/', detail: 'Gallery of public design systems.' },
      { label: 'Startups Gallery', url: 'https://startups.gallery/', detail: 'Top startup product and brand references.' },
    ],
  },
  {
    id: 'components',
    title: 'Components',
    sites: [
      { label: 'Base UI', url: 'https://base-ui.com/', detail: 'Unstyled accessible primitives for custom systems.' },
      { label: 'shadcn/ui', url: 'https://ui.shadcn.com/', detail: 'Composable React components built on Radix and Tailwind.' },
      { label: 'HeroUI', url: 'https://www.heroui.com/', detail: 'Modern React component library and design system.' },
      { label: 'Radix UI', url: 'https://www.radix-ui.com/', detail: 'Accessible low-level UI primitives.' },
      { label: 'React Aria', url: 'https://react-spectrum.adobe.com/react-aria/', detail: 'Accessible behavior primitives from Adobe.' },
      { label: 'Headless UI', url: 'https://headlessui.com/', detail: 'Unstyled accessible components for Tailwind projects.' },
      { label: 'MUI', url: 'https://mui.com/', detail: 'Material-based React component ecosystem.' },
      { label: 'Mantine', url: 'https://mantine.dev/', detail: 'Full-featured React components and hooks.' },
      { label: 'Chakra UI', url: 'https://chakra-ui.com/', detail: 'Accessible React components with theme tokens.' },
      { label: 'Ant Design', url: 'https://ant.design/', detail: 'Enterprise component system and patterns.' },
      { label: 'Ark UI', url: 'https://ark-ui.com/', detail: 'Headless components across modern frameworks.' },
      { label: 'daisyUI', url: 'https://daisyui.com/', detail: 'Tailwind CSS component classes and themes.' },
    ],
  },
  {
    id: 'guidelines',
    title: 'Guidelines & A11y',
    sites: [
      { label: 'Apple HIG', url: 'https://developer.apple.com/design/human-interface-guidelines', detail: 'Apple platform design guidelines.' },
      { label: 'Material Design', url: 'https://m3.material.io/', detail: "Google's Material Design 3." },
      { label: 'Laws of UX', url: 'https://lawsofux.com/', detail: 'UX principles and heuristics.' },
      { label: 'WebAIM Contrast', url: 'https://webaim.org/resources/contrastchecker/', detail: 'Color contrast checker.' },
      { label: 'The A11y Project', url: 'https://www.a11yproject.com/', detail: 'Accessibility checklist and patterns.' },
    ],
  },
  {
    id: 'tools',
    title: 'Tools & Resources',
    sites: [
      { label: 'Toolfolio', url: 'https://toolfolio.io/', detail: 'Design tools, resources, and collections.' },
      { label: 'GetDesign', url: 'https://getdesign.md/', detail: 'Curated design resources.' },
      { label: 'Taste Skill', url: 'https://www.tasteskill.dev/', detail: 'Design taste training and critique references.' },
      { label: 'UI Goodies', url: 'https://www.uigoodies.com/', detail: 'Hand-picked design resources.' },
      { label: 'Sidebar', url: 'https://sidebar.io/', detail: 'Five design links, every day.' },
      { label: 'Superset', url: 'https://github.com/superset-sh/superset', detail: 'Reference implementation for embedded browser workflows.' },
    ],
  },
];

/** Total number of curated references across every category (drives the "All" chip badge). */
export const REFERENCE_TOTAL = REFERENCE_GROUPS.reduce((sum, group) => sum + group.sites.length, 0);

/**
 * Filter the reference catalogue by an active category and a free-text query.
 *
 * `category` is either the sentinel `'all'` or a {@link ReferenceGroup.id}. The
 * query matches a site's label, hostname, or detail, OR the owning group's
 * title (so searching "color" surfaces the whole Color group). Groups with no
 * surviving sites are dropped, so the result is always ready to render as-is.
 */
export function filterReferenceGroups(
  groups: ReferenceGroup[],
  category: string,
  query: string,
  t?: (key: keyof Dict) => string,
): ReferenceGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  return groups
    .filter((group) => category === 'all' || group.id === category)
    .map((group) => {
      if (!needle) return group;
      const groupTitle = localizedReferenceGroupTitle(group, t);
      if (`${group.title} ${groupTitle}`.toLocaleLowerCase().includes(needle)) return group;
      const sites = group.sites.filter(
        (site) =>
          [
            site.label,
            site.detail,
            localizedReferenceSiteDetail(site, t),
            hostnameFromUrl(site.url),
          ].join(' ').toLocaleLowerCase().includes(needle),
      );
      return { ...group, sites };
    })
    .filter((group) => group.sites.length > 0);
}

export const BROWSER_USE_CATEGORIES: BrowserUseCategory[] = [
  {
    id: 'assets',
    title: 'Asset extraction',
    titleKey: 'browserUse.category.assets',
    searchTerms: ['assets', 'images', 'svg'],
    actions: [
      { id: 'extract_logo', label: 'extract_logo', input: 'none', output: 'Best logo candidates from header/nav/class/position plus og/favicon fallback.', prompt: 'Find likely site logo assets using DOM position, class names, header/nav context, OG image, and favicon evidence.' },
      { id: 'list_images', label: 'list_images', input: 'none', output: 'All img/srcset/source/CSS background images with dimensions and alt text.', prompt: 'Inventory every visible and CSS-referenced image, including dimensions, alt text, and source URLs.' },
      { id: 'download_assets', label: 'download_assets', input: 'kind: images|svgs|media|fonts, limit=200', output: 'Downloaded asset folder plus _manifest.json with referer/cookie support.', prompt: 'Download the requested asset kind from the bound Browser tab into the project and write a compact manifest.' },
      { id: 'extract_svgs', label: 'extract_svgs', input: 'none', output: 'Inline svg and linked .svg files saved as .svg.', prompt: 'Extract all inline and linked SVG assets from the page and save them as project files.' },
      { id: 'optimize_svgs', label: 'optimize_svgs', input: 'none', output: 'Optimized SVG files and compression ratio.', prompt: 'Extract page SVGs, lightly optimize comments/metadata/editor namespaces, and report compression ratios.' },
    ],
  },
  {
    id: 'tokens',
    title: 'Design language',
    titleKey: 'browserUse.category.tokens',
    searchTerms: ['tokens', 'palette', 'typography'],
    actions: [
      { id: 'extract_colors', label: 'extract_colors', input: 'none', output: 'Weighted palette plus :root CSS variables as palette.json and palette.html.', prompt: 'Extract the weighted color palette and CSS color variables, then save a JSON file and visual swatch preview.' },
      { id: 'extract_fonts', label: 'extract_fonts', input: 'none', output: 'Top font families, sizes, weights, and @font-face rules as typography.json.', prompt: 'Extract computed font families, size/weight usage, and @font-face declarations from the current page.' },
      { id: 'extract_design_tokens', label: 'extract_design_tokens', input: 'none', output: 'Radius, shadow, spacing, and CSS variables as tokens.json.', prompt: 'Extract reusable design tokens from computed CSS: radius, shadows, spacing, and custom properties.' },
      { id: 'extract_type_scale', label: 'extract_type_scale', input: 'none', output: 'h1-h6/p/button type scale with size, weight, line-height, and ratios.', prompt: 'Extract the effective typography scale for headings, body, buttons, labels, weights, line heights, and adjacent ratios.' },
      { id: 'extract_buttons', label: 'extract_buttons', input: 'none', output: 'Deduped button style library as buttons.html and buttons.json.', prompt: 'Extract a deduped gallery of button variants, states, labels, and computed styles.' },
      { id: 'extract_grid_system', label: 'extract_grid_system', input: 'none', output: 'Grid/flex containers, direction, gaps, columns, and max widths as layout.json.', prompt: 'Detect layout containers and grid/flex systems, including gaps, columns, directions, and max-width rules.' },
      { id: 'extract_breakpoints', label: 'extract_breakpoints', input: 'none', output: 'Responsive media-query breakpoints as breakpoints.json.', prompt: 'Extract responsive breakpoints from stylesheets and summarize what changes at each breakpoint.' },
      { id: 'extract_gradients', label: 'extract_gradients', input: 'none', output: 'CSS gradients as gradients.css, gradients.json, and preview HTML.', prompt: 'Find linear, radial, and conic gradients and save reusable CSS, JSON, and an HTML preview.' },
      { id: 'extract_shadows', label: 'extract_shadows', input: 'none', output: 'box-shadow, text-shadow, and drop-shadow as shadows.json plus preview.', prompt: 'Extract shadow styles from the page and generate a compact visual preview.' },
      { id: 'extract_easings', label: 'extract_easings', input: 'none', output: 'Transition/animation easing functions as easings.json.', prompt: 'Extract easing functions from CSS transitions and animations, including cubic-bezier, steps, and named easings.' },
      { id: 'export_tokens', label: 'export_tokens', input: 'none', output: 'tokens.css, tokens.scss, tailwind.theme.js, style-dictionary.tokens.json.', prompt: 'Export extracted tokens in CSS variables, SCSS, Tailwind theme, and Style Dictionary formats.' },
    ],
  },
  {
    id: 'motion',
    title: 'Motion',
    titleKey: 'browserUse.category.motion',
    searchTerms: ['animation', 'motion'],
    actions: [
      { id: 'extract_animations', label: 'extract_animations', input: 'optional selector', output: '@keyframes, transition/transform rules, detected motion libraries, motion.css, motion.json.', prompt: 'Extract animation evidence from the page or selector scope, including keyframes, transitions, transforms, and motion libraries.' },
    ],
  },
  {
    id: 'visual',
    title: 'Visual QA',
    titleKey: 'browserUse.category.visual',
    searchTerms: ['screenshot', 'accessibility', 'layout'],
    actions: [
      { id: 'validate_view', label: 'validate_view', input: 'requirement, selector? optional', output: 'Screenshot paths plus structured visual/layout issues.', prompt: 'Validate the current view against the requirement using screenshots plus layout audit evidence, then return issues and asset paths.' },
      { id: 'audit_layout', label: 'audit_layout', input: 'selector? optional', output: 'Layout defects: overflow, bounds, overlap, clipped text as audit.json.', prompt: 'Run a deterministic layout audit for overflow, out-of-bounds elements, text overlap, and clipped text.' },
      { id: 'audit_accessibility', label: 'audit_accessibility', input: 'selector? optional', output: 'A11y issues with selectors, labels, roles, focus, contrast, and screenshots where useful.', prompt: 'Audit accessibility evidence for the page or selector scope: names, roles, labels, focus order, contrast, and obvious keyboard traps.' },
      { id: 'responsive_screenshots', label: 'responsive_screenshots', input: 'none', output: 'Mobile 390, tablet 834, and desktop 1440 screenshots.', prompt: 'Capture mobile, tablet, and desktop screenshots for the current page and compare the main layout shifts.' },
      { id: 'screenshot_full', label: 'screenshot_full', input: 'scale=1', output: 'Full-page screenshot beyond the viewport.', prompt: 'Capture a full-page screenshot of the bound Browser tab and save it in the project.' },
      { id: 'screenshot_element', label: 'screenshot_element', input: 'selector, scale=2', output: 'Single element screenshot at 2x by default.', prompt: 'Capture a screenshot of the requested element selector, preferring a direct element capture over a cropped page image.' },
      { id: 'screenshot_with_grid', label: 'screenshot_with_grid', input: 'columns=12, maxWidth=1200, gap=24', output: 'Screenshot with layout grid overlay.', prompt: 'Overlay a responsive column grid on the page and capture a screenshot for alignment review.' },
      { id: 'screenshot_dark_mode', label: 'screenshot_dark_mode', input: 'none', output: 'Screenshot with prefers-color-scheme: dark.', prompt: 'Emulate dark color scheme and capture a screenshot of the page state.' },
      { id: 'generate_styleguide', label: 'generate_styleguide', input: 'none', output: 'One-page style guide with colors, type scale, radius, and shadows.', prompt: 'Generate a concise one-page style guide from page evidence: colors, typography, radius, shadows, and reusable UI notes.' },
    ],
  },
  {
    id: 'structure',
    title: 'Component structure',
    titleKey: 'browserUse.category.structure',
    searchTerms: ['html', 'copy', 'forms', 'nav'],
    actions: [
      { id: 'extract_html', label: 'extract_html', input: "selector='body'", output: 'Clean self-contained HTML without script/noscript/on* attributes.', prompt: 'Extract clean self-contained HTML for the selected area, removing scripts and inline event handlers.' },
      { id: 'extract_component_inventory', label: 'extract_component_inventory', input: 'none', output: 'Repeated component patterns, selectors, counts, and screenshots.', prompt: 'Inventory repeated component patterns such as cards, nav items, pricing rows, modals, accordions, and tables.' },
      { id: 'extract_copy', label: 'extract_copy', input: 'none', output: 'Headings, CTAs, body copy, descriptions as copy.md and copy.json.', prompt: 'Extract product copy from the page: headings, CTA labels, paragraphs, descriptions, and repeated text patterns.' },
      { id: 'extract_nav', label: 'extract_nav', input: 'none', output: 'Primary navigation and footer links as sitemap.md and nav.json.', prompt: 'Extract primary navigation, footer links, and sitemap-like structure from the current page.' },
      { id: 'extract_forms', label: 'extract_forms', input: 'none', output: 'Form fields, labels, validation hints, and submit actions as forms.json.', prompt: 'Extract form structure, labels, placeholders, validation hints, required states, and submit actions.' },
    ],
  },
  {
    id: 'project',
    title: 'Project runtime',
    titleKey: 'browserUse.category.project',
    searchTerms: ['dev server', 'framework'],
    actions: [
      { id: 'run_project', label: 'run_project', input: 'none', output: 'Detected dev server URL opened in Browser tab.', prompt: 'Detect, install if needed, run the project dev server, find the local URL, and open it in the Browser tab.' },
      { id: 'detect_project', label: 'detect_project', input: 'none', output: 'Framework, package manager, install command, dev command, and port.', prompt: 'Detect the project setup from package files, lockfiles, and framework config, then report install/dev commands and likely ports.' },
    ],
  },
  {
    id: 'general',
    title: 'General actions',
    titleKey: 'browserUse.category.general',
    searchTerms: ['metadata', 'navigate', 'terminal'],
    actions: [
      { id: 'page_info', label: 'page_info', input: 'none', output: 'URL, title, description, OG image, theme color, favicon, viewport.', prompt: 'Read compact metadata for the bound Browser tab: URL, title, description, OG/Twitter cards, theme color, favicon, and viewport.' },
      { id: 'snapshot', label: 'snapshot', input: 'none', output: 'Up to 120 visible interactive/text elements with tag, label, href, and coordinates.', prompt: 'Capture a compact DOM interaction snapshot for agent reasoning, capped to the most useful visible controls and text blocks.' },
      { id: 'navigate', label: 'navigate', input: 'url / domain / search terms', output: 'Open page and return page_info.', prompt: 'Navigate the bound Browser tab to the requested URL, domain, or search query, then report the resulting page_info.' },
      { id: 'click', label: 'click', input: 'selector', output: 'Click first matching element after scrolling it into view.', prompt: 'Click the first element matching the requested selector in the bound Browser tab, then report the visible result.' },
      { id: 'type_text', label: 'type_text', input: 'selector, text', output: 'Fill an input and dispatch input/change events.', prompt: 'Type the requested text into the selected input or editable element and dispatch the normal browser events.' },
      { id: 'scroll', label: 'scroll', input: 'pixels / top / bottom / page', output: 'Current and maximum scroll position.', prompt: 'Scroll the page by the requested amount or target, then report the resulting scroll position.' },
      { id: 'extract_og_metadata', label: 'extract_og_metadata', input: 'none', output: 'Meta title/description/canonical, OG/Twitter cards, social image, theme color.', prompt: 'Extract SEO and social preview metadata, including canonical, OG, Twitter card, image, and theme-color evidence.' },
      { id: 'terminal_run', label: 'terminal_run', input: 'command, timeoutMs=120000', output: 'stdout, stderr, and exit code.', prompt: 'Run the requested terminal command to completion in the shared project terminal and summarize stdout, stderr, and exit code.' },
      { id: 'terminal_run_background', label: 'terminal_run_background', input: 'command', output: 'Background task id and recent output.', prompt: 'Start the requested long-running terminal command in the background and report how to read its output.' },
      { id: 'terminal_read', label: 'terminal_read', input: 'maxChars=8000', output: 'Recent shared terminal output.', prompt: 'Read recent terminal output and extract URLs, errors, or readiness signals relevant to the bound Browser tab.' },
    ],
  },
];

export const BROWSER_USE_ACTION_TOTAL = BROWSER_USE_CATEGORIES.reduce(
  (sum, group) => sum + group.actions.length,
  0,
);

export function browserUseActionById(id: string): BrowserUseAction | null {
  for (const group of BROWSER_USE_CATEGORIES) {
    const action = group.actions.find((item) => item.id === id);
    if (action) return action;
  }
  return null;
}

export function filterBrowserUseCategories(
  groups: BrowserUseCategory[],
  query: string,
  localizeCategoryTitle?: (category: BrowserUseCategory) => string,
  localizeAction?: (action: BrowserUseAction) => string[],
): BrowserUseCategory[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => {
      const localizedTitle = localizeCategoryTitle?.(group) ?? group.title;
      const groupMatches = [
        group.title,
        localizedTitle,
        ...(group.searchTerms ?? []),
      ].some((value) => value.toLocaleLowerCase().includes(needle));
      const actions = groupMatches
        ? group.actions
        : group.actions.filter((action) =>
          [
            action.id,
            action.label,
            action.input,
            action.output,
            action.prompt,
            ...(localizeAction?.(action) ?? []),
          ].some((value) => value.toLocaleLowerCase().includes(needle)),
        );
      return { ...group, actions };
    })
    .filter((group) => group.actions.length > 0);
}

export function browserUsePrompt(action: BrowserUseAction, context: BrowserUsePromptContext = {}): string {
  const title = context.title?.trim() || '(untitled)';
  const url = context.url?.trim() || EMPTY_URL;
  const tabLabel = context.tabLabel?.trim() || title || labelFromUrl(url);
  const browserFilePath = context.browserFilePath?.trim();
  const resolvedDir = context.resolvedDir?.trim();
  return [
    '@agent-browser',
    '',
    'Use the selected OpenDesign Browser tab as the bound target.',
    'Browser tab context:',
    `- tab: ${tabLabel}`,
    `- title: ${title}`,
    `- url: ${url}`,
    ...(browserFilePath ? [`- browser context path: ${browserFilePath}`] : []),
    ...(context.projectId ? [`- project id: ${context.projectId}`] : []),
    ...(resolvedDir ? [`- project directory: ${resolvedDir}`] : []),
    '',
    `Operation: ${action.id}`,
    `Input contract: ${action.input}`,
    `Expected output: ${action.output}`,
    '',
    `Task: ${action.prompt}`,
    '',
    'Evidence rules:',
    '1. Use browser-use / browser-harness style evidence: page_info, DOM snapshot, screenshots, accessibility tree, OG metadata, computed CSS, fonts, colors, motion rules, and layout audit as relevant.',
    '2. First confirm the bound tab URL/title. If the tab is blank and the operation needs a page, ask for or navigate to the target before extracting evidence.',
    '3. Save bulky assets, screenshots, manifests, and HTML extracts in the project, then summarize paths instead of pasting large dumps into chat.',
    '4. Return a concise result with evidence paths, key selectors, and any follow-up action needed.',
  ].join('\n');
}

const ADD_IMAGE_TO_CHAT_MESSAGE = '__open_design_add_image_to_chat__:';
const browserImageHoverScript = (addToChatLabel: string) => String.raw`(() => {
  const rootId = '__open_design_image_hover_layer__';
  window.__openDesignImageHoverCleanup?.();
  document.getElementById(rootId)?.remove();
  const controller = new AbortController();

  const layer = document.createElement('div');
  layer.id = rootId;
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, {
    position: 'fixed',
    zIndex: '2147483646',
    display: 'none',
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    padding: '10px',
    // No dim/frost wash over the image — the layer is an invisible flex
    // frame that pins the button to the hovered image's top-right corner.
    background: 'transparent',
    pointerEvents: 'none',
    borderRadius: '6px',
    boxSizing: 'border-box',
  });

  const button = document.createElement('button');
  button.type = 'button';
  const addToChatLabel = ${JSON.stringify(addToChatLabel)};
  button.textContent = addToChatLabel;
  button.setAttribute('aria-label', addToChatLabel);
  Object.assign(button.style, {
    height: '34px',
    padding: '0 14px',
    border: 'none',
    borderRadius: '6px',
    background: 'rgba(24,24,25,.92)',
    color: '#00ff04',
    boxShadow: '0 8px 24px rgba(0,0,0,.28)',
    font: '600 13px/1 system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    letterSpacing: '0',
    cursor: 'pointer',
    pointerEvents: 'auto',
  });
  layer.appendChild(button);
  document.documentElement.appendChild(layer);

  let activeImage = null;
  const eligibleImage = (node) => {
    const image = node instanceof Element ? node.closest('img') : null;
    if (!(image instanceof HTMLImageElement)) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width < 72 || rect.height < 56 || rect.bottom <= 0 || rect.right <= 0) return null;
    return image;
  };
  const positionLayer = () => {
    if (!activeImage || !activeImage.isConnected) {
      activeImage = null;
      layer.style.display = 'none';
      return;
    }
    const rect = activeImage.getBoundingClientRect();
    if (rect.width < 72 || rect.height < 56 || rect.bottom <= 0 || rect.top >= innerHeight) {
      layer.style.display = 'none';
      return;
    }
    Object.assign(layer.style, {
      display: 'flex',
      left: Math.max(0, rect.left) + 'px',
      top: Math.max(0, rect.top) + 'px',
      width: Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) + 'px',
      height: Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) + 'px',
    });
  };
  document.addEventListener('pointermove', (event) => {
    if (button.contains(event.target)) return;
    const image = eligibleImage(event.target);
    if (image === activeImage) return;
    activeImage = image;
    positionLayer();
  }, { capture: true, signal: controller.signal });
  // No capture: pointerleave does not bubble, so this fires only when the
  // pointer leaves the document itself. A capturing listener would also fire
  // when the pointer crosses from the image onto the overlay button, hiding
  // the layer and clearing activeImage before the button can be clicked.
  document.addEventListener('pointerleave', () => {
    activeImage = null;
    layer.style.display = 'none';
  }, { signal: controller.signal });
  addEventListener('scroll', positionLayer, { capture: true, signal: controller.signal });
  addEventListener('resize', positionLayer, { capture: true, signal: controller.signal });

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!activeImage) return;
    const rect = activeImage.getBoundingClientRect();
    const payload = {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.max(1, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)),
      height: Math.max(1, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)),
      alt: activeImage.alt || '',
      src: activeImage.currentSrc || activeImage.src || '',
    };
    layer.style.display = 'none';
    // Let the guest paint the hidden overlay before notifying the host;
    // the host's own rAF wait cannot see guest frames, so capturing too
    // early bakes the dimmed layer and button into the snapshot.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      console.info('${ADD_IMAGE_TO_CHAT_MESSAGE}' + JSON.stringify(payload));
    }));
  }, { signal: controller.signal });
  window.__openDesignImageHoverCleanup = () => {
    controller.abort();
    layer.remove();
    delete window.__openDesignImageHoverCleanup;
  };
  return true;
})()`;

const PAGE_BRIEF_SCRIPT = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) || '';
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((node) => clean(node.textContent))
    .filter(Boolean)
    .slice(0, 18);
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((node) => ({ text: clean(node.textContent), url: node.href }))
    .filter((item) => item.url && item.text)
    .slice(0, 28);
  const images = Array.from(document.images)
    .map((image) => image.currentSrc || image.src)
    .filter(Boolean)
    .slice(0, 24);
  const colorCounts = new Map();
  const transparent = new Set(['rgba(0, 0, 0, 0)', 'transparent']);
  for (const element of Array.from(document.querySelectorAll('body, body *')).slice(0, 700)) {
    const style = getComputedStyle(element);
    for (const prop of ['color', 'backgroundColor', 'borderColor']) {
      const value = style[prop];
      if (!value || transparent.has(value)) continue;
      colorCounts.set(value, (colorCounts.get(value) || 0) + 1);
    }
  }
  return {
    title: clean(document.title),
    url: location.href,
    description: clean(attr('meta[name="description"]', 'content') || attr('meta[property="og:description"]', 'content')),
    headings,
    images,
    links,
    colors: Array.from(colorCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 16)
      .map(([value, count]) => ({ value, count })),
  };
})()`;

export function DesignBrowserPanel({
  initialIconUrl,
  initialTitle,
  initialUrl,
  navigateRequest,
  attentionRequest,
  projectId,
  conversationId = null,
  resolvedDir,
  onOpenFile,
  onOpenDesignFiles,
  onPageInfoChange,
  onRefreshFiles,
  previewComments = EMPTY_PREVIEW_COMMENTS,
  onSavePreviewComment,
  onRemovePreviewComment,
  onStagePreviewComments,
  onAddImageToChat,
  onRequestBrowserUsePrompt,
  onPageSnapshotToast,
  sendDisabled = false,
  browserTabId,
  browserTabActive = true,
  popup,
  onBrowserRetentionChange,
}: DesignBrowserPanelProps) {
  const t = useT();
  const { workspaceContext } = useProjectCollabContext();
  const desktopHostAvailable = isOpenDesignHostAvailable();
  const initialState = initialBrowserState(initialUrl, initialTitle);
  // `loadUrl` is the navigation target bound to the <webview>/<iframe> `src`.
  // It changes ONLY on user-initiated navigation. `currentUrl` is the committed
  // location shown in the address bar and recorded in history, synced from the
  // webview's own navigation events. They are deliberately separate: if `src`
  // tracked every committed URL, a server redirect (e.g. adding a trailing
  // slash) would mutate `src` mid-load and Electron would abort the in-flight
  // navigation (ERR_ABORTED -3), leaving the page blank.
  const [loadUrl, setLoadUrl] = useState(initialState.url);
  const [currentUrl, setCurrentUrl] = useState(initialState.url);
  const [addressValue, setAddressValue] = useState(initialState.addressValue);
  const [addressEditing, setAddressEditing] = useState(false);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>(() => loadHistory(projectId));
  const [navigationStack, setNavigationStack] = useState<BrowserNavigationEntry[]>(initialState.navigationStack);
  const [navigationIndex, setNavigationIndex] = useState(initialState.navigationIndex);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewportMenuOpen, setViewportMenuOpen] = useState(false);
  const [browserUseOpen, setBrowserUseOpen] = useState(false);
  const [edgeAnnotationsOpen, setEdgeAnnotationsOpen] = useState(false);
  const [browserDiagnosticsOpen, setBrowserDiagnosticsOpen] = useState(false);
  const [browserDiagnosticsLoading, setBrowserDiagnosticsLoading] = useState(false);
  const [browserDiagnosticsError, setBrowserDiagnosticsError] = useState<string | null>(null);
  const [browserDiagnostics, setBrowserDiagnostics] = useState<BrowserDiagnostics>({
    consoleEntries: [],
    networkEntries: [],
  });
  const [isLoading, setIsLoading] = useState(false);
  const [webviewNode, setWebviewNode] = useState<WebviewElement | null>(null);
  const [webContentsId, setWebContentsId] = useState<number | null>(null);
  const currentWebviewRef = useRef(webviewNode);
  currentWebviewRef.current = webviewNode;
  const [popupViewport, setPopupViewport] = useState<HTMLDivElement | null>(null);
  const [popupPixels, setPopupPixels] = useState<string | null>(null);
  const popupRef = useRef(popup);
  popupRef.current = popup;
  const popupSurface = useMemo(() => popupViewport && popupRef.current
    ? createPopupBrowserSurface(popupViewport, popupRef.current) : null, [popupViewport, popup?.surfaceId]);
  useEffect(() => {
    if (!popupSurface) return;
    const disconnect = popupSurface.connect();
    setWebviewNode(popupSurface.page);
    setWebContentsId(popupSurface.page.getWebContentsId());
    return () => { disconnect(); void popupSurface.present(false).catch(() => {}); setWebviewNode(null); setWebContentsId(null); };
  }, [popupSurface]);
  useEffect(() => { if (popup && popupSurface) popupSurface.update(popup); }, [popup, popupSurface]);
  const [browserControlStatus, setBrowserControlStatus] =
    useState<EmbeddedBrowserControlStatus>('unavailable');
  const [drawOverlayOpen, setDrawOverlayOpen] = useState(false);
  const viewportFrameRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewportState] = useState<BrowserViewportId>(() => loadBrowserViewport(projectId));
  const [viewportChanging, setViewportChanging] = useState(false);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const viewportRequestRef = useRef(0);
  const viewportReadyRef = useRef<{ check: () => void; reject: (error: Error) => void } | null>(null);
  useEffect(() => () => {
    viewportReadyRef.current?.reject(new Error('Browser viewport is no longer available'));
  }, [projectId]);
  const viewportGuardDiagnosticsRef = useRef(0);
  const browserActiveRef = useRef(browserTabActive);
  browserActiveRef.current = browserTabActive;
  const popupPresentationRef = useRef<(() => Promise<void>) | null>(null);
  const applyViewportRef = useRef<NonNullable<EmbeddedBrowserControlSessionOptions['applyViewport']>>(async () => { throw new Error('Browser viewport is not ready'); });
  const applyViewport = useCallback<NonNullable<EmbeddedBrowserControlSessionOptions['applyViewport']>>((preset, expiresAt) => applyViewportRef.current(preset, expiresAt), []);
  const setViewport = useCallback((nextViewport: BrowserViewportId) => {
    saveBrowserViewport(projectId, nextViewport);
    setViewportState(nextViewport);
  }, [projectId]);
  const viewportPreset = BROWSER_VIEWPORT_PRESETS.find((preset) => preset.id === viewport)!;
  applyViewportRef.current = async (preset, expiresAt = Date.now() + 30_000) => {
    const request = ++viewportRequestRef.current;
    const frame = viewportFrameRef.current;
    if (!browserTabActive || !frame || frame.getBoundingClientRect().width <= 0) {
      throw new Error('Activate this browser tab before changing its viewport');
    }
    viewportReadyRef.current?.reject(new Error('Browser viewport changed while applying the preset; retry the command'));
    const requestedPreset = BROWSER_VIEWPORT_PRESETS.find((candidate) => candidate.id === preset)!;
    const ready = new Promise<void>((resolve, reject) => {
      let available: DOMRect | null = null;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (viewportReadyRef.current === pending) viewportReadyRef.current = null;
        if (error) reject(error); else resolve();
      };
      const pending = { reject: (error: Error) => finish(error), check: () => {
        if (Date.now() >= expiresAt) return finish(new Error('Browser command expired before execution.'));
        if (request !== viewportRequestRef.current || frame !== viewportFrameRef.current || !frame.isConnected
          || !browserActiveRef.current || document.visibilityState === 'hidden') {
          return finish(new Error('Browser viewport is no longer available'));
        }
        if (viewportRef.current !== preset || frame.dataset.viewport !== preset) return;
        const parent = frame.parentElement?.getBoundingClientRect();
        const rect = frame.getBoundingClientRect();
        if (!parent || parent.width <= 0 || parent.height <= 0 || rect.width <= 0 || rect.height <= 0) {
          return finish(new Error('Browser viewport has no visible frame'));
        }
        if (available && (parent.width !== available.width || parent.height !== available.height)) {
          return finish(new Error('Browser viewport changed while applying the preset; retry the command'));
        }
        available = parent;
        const width = Math.min(requestedPreset.width ?? parent.width, parent.width);
        const height = Math.min(requestedPreset.height ?? parent.height, parent.height);
        if (Math.abs(rect.width - width) <= 1 && Math.abs(rect.height - height) <= 1) finish();
      } };
      const timer = setTimeout(() => finish(new Error('Browser command expired before execution.')), Math.max(0, expiresAt - Date.now()));
      viewportReadyRef.current = pending;
      setViewport(preset);
      // The existing ResizeObserver acknowledges fitted layout. A committed
      // React preset alone can still expose the previous CSS frame dimensions.
      pending.check();
    });
    await ready;
    const requestedRect = frame.getBoundingClientRect();
    // Bounded numeric diagnostics distinguish committed style from frame layout.
    // Never include page content, URLs or arbitrary computed-style text.
    const describeFrame = () => {
      const computedWidth = Number.parseFloat(getComputedStyle(frame).width);
      const parentRect = frame.parentElement?.getBoundingClientRect();
      return { currentFrame: frame === viewportFrameRef.current, domPresetMatches: frame.dataset.viewport === preset,
        inlineWidthMatches: frame.style.width === (requestedPreset.width ? `min(${requestedPreset.width}px, 100%)` : '100%'),
        clientWidth: frame.clientWidth, offsetWidth: frame.offsetWidth,
        computedWidth: Number.isFinite(computedWidth) ? computedWidth : null,
        parentWidth: parentRect?.width ?? null };
    };
    const beforePresentation = describeFrame();
    // Child views live outside DOM composition. Their geometry must be applied
    // before the shared command reports the fitted frame to UI or CLI callers.
    await popupPresentationRef.current?.();
    if (Date.now() >= expiresAt) throw new Error('Browser command expired before execution.');
    const rect = frame.getBoundingClientRect();
    if (request !== viewportRequestRef.current || viewportRef.current !== preset || !browserActiveRef.current
      || !frame.isConnected || rect.width !== requestedRect.width || rect.height !== requestedRect.height) {
      if (viewportGuardDiagnosticsRef.current++ < 20) console.warn(JSON.stringify({ logger: 'browser.viewport.guard',
        event: 'changed-during-presentation', request, currentRequest: viewportRequestRef.current,
        presetMatches: viewportRef.current === preset, active: browserActiveRef.current, connected: frame.isConnected,
        requestedWidth: requestedRect.width, requestedHeight: requestedRect.height,
        measuredWidth: rect.width, measuredHeight: rect.height,
        beforePresentation, afterPresentation: describeFrame() }));
      throw new Error('Browser viewport changed while applying the preset; retry the command');
    }
    const size = { width: Math.round(rect.width), height: Math.round(rect.height) };
    if (size.width <= 0 || size.height <= 0) throw new Error('Browser viewport has no visible frame');
    setViewportSize(size);
    return { preset, ...size };
  };
  const selectViewport = async (preset: BrowserViewportId) => {
    setViewportChanging(true);
    setViewportError(null);
    try {
      if (browserControlStatus === 'connected' && browserTabId) {
        await executeEmbeddedBrowserOperation(projectId, { operation: 'viewport', preset }, {
          tabId: browserTabId,
          ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
        });
      } else {
        await applyViewport(preset);
      }
    } catch (error) {
      setViewportError(error instanceof Error ? error.message : 'Browser viewport change failed');
    } finally { setViewportChanging(false); }
  };
  useEffect(() => {
    const frame = viewportFrameRef.current;
    if (!frame) return;
    const measure = () => {
      const rect = frame.getBoundingClientRect();
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setViewportSize((current) => current.width === next.width && current.height === next.height ? current : next);
      viewportReadyRef.current?.check();
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(frame);
    if (frame.parentElement) observer?.observe(frame.parentElement);
    window.addEventListener('resize', measure); document.addEventListener('visibilitychange', measure); measure();
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); document.removeEventListener('visibilitychange', measure); };
  }, [viewport, browserTabActive]);
  const [activeTool, setActiveTool] = useState<BrowserTool | null>(null);
  const [activeCommentTarget, setActiveCommentTarget] = useState<BrowserElementSnapshot | null>(null);
  const activeCommentTargetRef = useRef(activeCommentTarget);
  activeCommentTargetRef.current = activeCommentTarget;
  const captureCleanupRef = useRef<Promise<File | null> | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  /** Which control opened the current saved pin, so closing can hand focus back to it. */
  const pinOpenOriginRef = useRef<'badge' | 'dock' | null>(null);
  const liveEditRevisionRef = useRef(0);
  const liveEditInFlightRef = useRef(false);
  const [applyingBrowserEdit, setApplyingBrowserEdit] = useState(false);
  const applyStyleRef = useRef<NonNullable<EmbeddedBrowserControlSessionOptions['applyStyle']>>(async () => { throw new Error('Browser style editing is not ready'); });
  const applyStyle = useCallback<NonNullable<EmbeddedBrowserControlSessionOptions['applyStyle']>>((request, expiresAt) => applyStyleRef.current(request, expiresAt), []);
  const [activePreviewCommentId, setActivePreviewCommentId] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [queuedCommentNotes, setQueuedCommentNotes] = useState<string[]>([]);
  const [browserImages, setBrowserImages] = useState<File[]>([]);
  const annotationCaptureDiagnosticsRef = useRef(0);
  const [browserImagePreviews, setBrowserImagePreviews] = useState<{ file: File; url: string }[]>([]);
  const [browserPreviewIndex, setBrowserPreviewIndex] = useState<number | null>(null);
  const [sendingComment, setSendingComment] = useState(false);
  const [savingDomEdit, setSavingDomEdit] = useState(false);
  const [browserLiveCommentTargets, setBrowserLiveCommentTargets] = useState<Map<string, BrowserElementSnapshot>>(() => new Map());
  const [selectedPinIds, setSelectedPinIds] = useState<Set<string>>(() => new Set());
  const [pinDockCollapsed, setPinDockCollapsed] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const [captureChromeHidden, setCaptureChromeHidden] = useState(false);
  const [statusMessage, setStatusMessage] = useState<BrowserStatusMessage | null>(null);
  const [savingActions, setSavingActions] = useState<Record<BrowserSavingAction, boolean>>({
    archive: false,
    brief: false,
    screenshot: false,
  });
  const [archiveElapsedSeconds, setArchiveElapsedSeconds] = useState(0);
  const [downloadAttentionNonce, setDownloadAttentionNonce] = useState<number | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const pickerRequestIdRef = useRef(0);
  const restoredIconUrlRef = useRef(initialIconUrl?.trim() ?? '');
  const restoredTitleRef = useRef(initialTitle?.trim() ?? '');
  const navigationStackRef = useRef<BrowserNavigationEntry[]>(initialState.navigationStack);
  const navigationIndexRef = useRef(initialState.navigationIndex);
  const pendingLoadTargetRef = useRef<string | null>(null);
  const lastNavigateRequestNonceRef = useRef<number | null>(null);
  const archiveRunIdRef = useRef(0);
  const archiveRunRef = useRef<{ controller: AbortController; id: number; startedAt: number } | null>(null);
  const pageSnapshotToastRef = useRef(onPageSnapshotToast);
  const browserTabIdRef = useRef(browserTabId ?? '');
  const browserControlSessionRef = useRef<EmbeddedBrowserControlSession | null>(null);
  const archiveSaving = savingActions.archive;
  const briefSaving = savingActions.brief;
  const screenshotSaving = savingActions.screenshot;
  const canGoBack = popup ? popup.canGoBack : navigationIndex > 0;
  const canGoForward = popup ? popup.canGoForward : navigationIndex >= 0 && navigationIndex < navigationStack.length - 1;

  const setSavingAction = useCallback((action: BrowserSavingAction, saving: boolean) => {
    setSavingActions((current) => (
      current[action] === saving ? current : { ...current, [action]: saving }
    ));
  }, []);

  const cancelPageSnapshot = useCallback(() => {
    archiveRunRef.current?.controller.abort();
  }, []);

  useEffect(() => {
    pageSnapshotToastRef.current = onPageSnapshotToast;
    browserTabIdRef.current = browserTabId ?? '';
  }, [browserTabId, onPageSnapshotToast]);

  const emitPageSnapshotToast = useCallback((event: Omit<BrowserPageSnapshotToastEvent, 'tabId'>) => {
    pageSnapshotToastRef.current?.({
      ...event,
      tabId: browserTabIdRef.current,
    });
  }, []);

  // Publish a handle to this tab's live webview so the chat can read the rendered
  // DOM (brand browser-assist re-extraction). The cross-origin <iframe> fallback
  // can't expose guest DOM, so `isDesktopWebview` gates that path off there.
  useEffect(() => {
    if (!browserTabId) return undefined;
    const handle: BrandBrowserHandle = {
      isDesktopWebview: desktopHostAvailable && Boolean(webviewNode),
      getURL: () => webviewNode?.getURL?.() ?? currentUrl,
      executeJavaScript: (code, gesture) =>
        webviewNode ? webviewNode.executeJavaScript(code, gesture) : null,
      downloadPageSnapshot: () => savePageSnapshot({ openAfterSave: false }),
    };
    registerBrandBrowser(projectId, browserTabId, handle);
    return () => registerBrandBrowser(projectId, browserTabId, null);
  }, [browserTabId, projectId, webviewNode, currentUrl, desktopHostAvailable]);
  const assignWebviewNode = useCallback((node: HTMLWebViewElement | null) => {
    if (browserTabId && getHostBrowserPopups()) onBrowserRetentionChange?.(browserTabId, Boolean(node));
    if (!node) setWebContentsId(null);
    setWebviewNode(node as WebviewElement | null);
  }, [browserTabId, onBrowserRetentionChange]);

  useEffect(() => {
    setViewportState(loadBrowserViewport(projectId));
    setHistory(loadHistory(projectId));
    const nextInitialState = initialBrowserState(initialUrl, initialTitle);
    setLoadUrl(nextInitialState.url);
    setCurrentUrl(nextInitialState.url);
    setAddressValue(nextInitialState.addressValue);
    setAddressEditing(false);
    setNavigationStack(nextInitialState.navigationStack);
    setNavigationIndex(nextInitialState.navigationIndex);
    navigationStackRef.current = nextInitialState.navigationStack;
    navigationIndexRef.current = nextInitialState.navigationIndex;
    pendingLoadTargetRef.current = null;
    if (isHistoryUrl(nextInitialState.url)) {
      commitHistory(
        nextInitialState.url,
        { iconUrl: initialIconUrl, title: initialTitle },
        { countVisit: false },
      );
    }
    // `initial*` props are mount-time tab restore inputs. During normal
    // navigation the parent updates them from onPageInfoChange; that must not
    // reset the live webview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => saveHistory(projectId, history), 140);
    return () => window.clearTimeout(timer);
  }, [history, projectId]);

  useEffect(() => {
    if (!statusMessage) return;
    // Keep the status pinned while the page-snapshot download runs: it can take
    // several seconds, and a 2.6s auto-dismiss would leave the user staring at a
    // disabled Download Page action with no sign it's still working. When saving
    // ends, the effect re-runs and the success/failure message dismisses normally.
    if (archiveSaving) return;
    const hasAction = typeof statusMessage === 'object' && Boolean(statusMessage.actionFileName);
    const timer = window.setTimeout(() => setStatusMessage(null), hasAction ? 8000 : 2600);
    return () => window.clearTimeout(timer);
  }, [statusMessage, archiveSaving]);

  // Latest snapshot-progress publisher, kept in a ref so the 1s ticker effect
  // below can depend only on `archiveSaving`. `emitPageSnapshotToast` and `t`
  // get a fresh identity on every parent render (FileWorkspace passes a new
  // `onPageSnapshotToast` each render), so listing them as effect deps made the
  // effect tear down and re-run every render — and its immediate publish() then
  // set state on each run, re-rendering in a tight loop until React aborted with
  // "Maximum update depth exceeded". Reading the ref sidesteps that, and the
  // single stable interval also stops the parent toast from being replaced ~60×
  // a second (which rendered as overlapping/duplicate snapshot toasts).
  const publishSnapshotProgressRef = useRef<() => void>(() => {});
  publishSnapshotProgressRef.current = () => {
    const run = archiveRunRef.current;
    if (!run) return;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
    setArchiveElapsedSeconds(elapsedSeconds);
    emitPageSnapshotToast({
      elapsedSeconds,
      message: t('designBrowser.status.pageSnapshotStarted'),
      onCancel: cancelPageSnapshot,
      status: 'loading',
      ttlMs: 0,
    });
  };

  useEffect(() => {
    if (!archiveSaving || !archiveRunRef.current) return;
    publishSnapshotProgressRef.current();
    const interval = window.setInterval(() => publishSnapshotProgressRef.current(), 1000);
    return () => window.clearInterval(interval);
  }, [archiveSaving]);

  useEffect(() => {
    if (!menuOpen && !suggestionsOpen && !browserUseOpen && !browserDiagnosticsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const chrome = chromeRef.current;
      if (chrome && event.target instanceof Node && chrome.contains(event.target)) return;
      setMenuOpen(false);
      setSuggestionsOpen(false);
      setBrowserUseOpen(false);
      setBrowserDiagnosticsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [browserDiagnosticsOpen, browserUseOpen, menuOpen, suggestionsOpen]);

  const commitHistory = useCallback((url: string, meta: { title?: string; iconUrl?: string } = {}, options: { countVisit?: boolean } = {}) => {
    if (!isHistoryUrl(url)) return;
    setHistory((current) => {
      const now = Date.now();
      const existing = current.find((entry) => sameUrl(entry.url, url));
      const nextTitle = meta.title && meta.title.trim()
        ? meta.title.trim()
        : existing?.title || labelFromUrl(url);
      const nextIconUrl = cleanIconUrl(meta.iconUrl) || existing?.iconUrl || faviconUrl(url);
      const visitIncrement = options.countVisit === false ? 0 : 1;
      const entry = existing
        ? {
            ...existing,
            iconUrl: nextIconUrl,
            title: nextTitle,
            lastVisitedAt: visitIncrement > 0 ? now : existing.lastVisitedAt,
            visitCount: existing.visitCount + visitIncrement,
          }
        : { iconUrl: nextIconUrl, title: nextTitle, url, lastVisitedAt: now, visitCount: 1 };
      if (
        existing &&
        existing.title === entry.title &&
        existing.iconUrl === entry.iconUrl &&
        existing.lastVisitedAt === entry.lastVisitedAt &&
        existing.visitCount === entry.visitCount
      ) {
        return current;
      }
      return [entry, ...current.filter((item) => !sameUrl(item.url, url))]
        .slice(0, HISTORY_LIMIT);
    });
  }, []);

  const setNavigationState = useCallback((stack: BrowserNavigationEntry[], index: number) => {
    navigationStackRef.current = stack;
    navigationIndexRef.current = index;
    setNavigationStack(stack);
    setNavigationIndex(index);
  }, []);

  const recordNavigation = useCallback((url: string, title?: string, options?: { replacePendingTarget?: boolean }) => {
    if (url !== EMPTY_URL && !isHistoryUrl(url)) return;

    const stack = navigationStackRef.current;
    const index = navigationIndexRef.current;
    const nextTitle = url === EMPTY_URL
      ? browserHomeNavigationEntry().title
      : title && title.trim()
        ? title.trim()
        : labelFromUrl(url);
    const nextEntry: BrowserNavigationEntry = { title: nextTitle, url };
    const updateEntry = (entries: BrowserNavigationEntry[], entryIndex: number) => {
      const existing = entries[entryIndex];
      const next = entries.slice();
      next[entryIndex] = {
        title: nextTitle || existing?.title || labelFromUrl(url),
        url,
      };
      return next;
    };
    const currentEntry = index >= 0 ? stack[index] : undefined;
    const pendingTarget = pendingLoadTargetRef.current;
    const shouldReplacePending =
      Boolean(options?.replacePendingTarget && pendingTarget && currentEntry && sameUrl(currentEntry.url, pendingTarget));

    if (currentEntry && (sameUrl(currentEntry.url, url) || shouldReplacePending)) {
      setNavigationState(updateEntry(stack, index), index);
      if (options?.replacePendingTarget) pendingLoadTargetRef.current = null;
      return;
    }

    const previousIndex = index - 1;
    if (previousIndex >= 0 && sameUrl(stack[previousIndex]?.url ?? '', url)) {
      setNavigationState(updateEntry(stack, previousIndex), previousIndex);
      if (options?.replacePendingTarget) pendingLoadTargetRef.current = null;
      return;
    }

    const nextIndex = index + 1;
    if (nextIndex < stack.length && sameUrl(stack[nextIndex]?.url ?? '', url)) {
      setNavigationState(updateEntry(stack, nextIndex), nextIndex);
      if (options?.replacePendingTarget) pendingLoadTargetRef.current = null;
      return;
    }

    const base = index >= 0 ? stack.slice(0, index + 1) : [];
    const nextStack = [...base, nextEntry].slice(-HISTORY_LIMIT);
    setNavigationState(nextStack, nextStack.length - 1);
    if (options?.replacePendingTarget) pendingLoadTargetRef.current = null;
  }, [setNavigationState]);

  const updateCurrentNavigationTitle = useCallback((title?: string) => {
    const trimmedTitle = title?.trim();
    const index = navigationIndexRef.current;
    if (!trimmedTitle || index < 0) return;
    const stack = navigationStackRef.current;
    const currentEntry = stack[index];
    if (!currentEntry || currentEntry.title === trimmedTitle) return;
    const nextStack = stack.slice();
    nextStack[index] = { ...currentEntry, title: trimmedTitle };
    setNavigationState(nextStack, index);
  }, [setNavigationState]);

  const loadWebviewUrl = useCallback((url: string) => {
    if (!webviewNode) {
      setLoadUrl(url);
      return;
    }
    if (loadUrl === EMPTY_URL && !popup) {
      setLoadUrl(url);
      return;
    }
    try {
      const result = webviewNode.loadURL?.(url);
      if (isPromiseLike(result)) {
        void result.catch((error) => {
          if (isBenignWebviewLoadAbort(error)) return;
          setLoadUrl(url);
        });
      }
      else if (!webviewNode.loadURL) setLoadUrl(url);
    } catch (error) {
      if (isBenignWebviewLoadAbort(error)) return;
      setLoadUrl(url);
    }
  }, [loadUrl, webviewNode, popup]);

  const navigateTo = useCallback((rawAddress: string) => {
    const nextUrl = normalizeBrowserAddress(rawAddress);
    warmBrowserOrigin(nextUrl);
    pendingLoadTargetRef.current = isHistoryUrl(nextUrl) ? nextUrl : null;
    setCurrentUrl(nextUrl);
    setAddressValue(nextUrl === EMPTY_URL ? '' : nextUrl);
    setAddressEditing(false);
    setSuggestionsOpen(false);
    setMenuOpen(false);
    setBrowserUseOpen(false);
    if (isHistoryUrl(nextUrl)) {
      commitHistory(nextUrl, undefined, { countVisit: true });
      recordNavigation(nextUrl);
    } else if (nextUrl === EMPTY_URL) {
      setLoadUrl(EMPTY_URL);
      recordNavigation(nextUrl);
    }
    if (nextUrl !== EMPTY_URL || popup) loadWebviewUrl(nextUrl);
  }, [commitHistory, loadWebviewUrl, recordNavigation, popup]);

  useEffect(() => {
    if (!navigateRequest) return;
    if (lastNavigateRequestNonceRef.current === navigateRequest.nonce) return;
    lastNavigateRequestNonceRef.current = navigateRequest.nonce;
    navigateTo(navigateRequest.url);
  }, [navigateRequest, navigateTo]);

  useEffect(() => {
    if (!attentionRequest || attentionRequest.action !== 'download-page') return;
    setBrowserUseOpen(false);
    setSuggestionsOpen(false);
    setMenuOpen(true);
    setDownloadAttentionNonce(attentionRequest.nonce);
    setStatusMessage(null);
  }, [attentionRequest]);

  const syncFromFallbackFrame = useCallback((frame: HTMLIFrameElement | null) => {
    if (!frame || loadUrl === EMPTY_URL) return;
    let nextUrl = loadUrl;
    let nextTitle = '';
    try {
      nextUrl = frame.contentWindow?.location.href || loadUrl;
      nextTitle = frame.contentDocument?.title?.trim() || '';
    } catch {
      // Cross-origin iframe content is expected to reject here. Keep the URL
      // context and let the display fall back to labelFromUrl().
    }
    setCurrentUrl(nextUrl);
    if (!addressEditing) setAddressValue(nextUrl);
    commitHistory(nextUrl, { title: nextTitle }, { countVisit: false });
    recordNavigation(nextUrl, nextTitle, { replacePendingTarget: true });
    updateCurrentNavigationTitle(nextTitle);
    setIsLoading(false);
  }, [addressEditing, commitHistory, loadUrl, recordNavigation, updateCurrentNavigationTitle]);

  const updateLoadingState = useCallback((node: WebviewElement | null = webviewNode) => {
    if (!node) {
      setIsLoading(false);
      return;
    }
    // Electron's <webview> throws ("The WebView must be attached to the DOM and
    // the dom-ready event emitted before this method can be called") when
    // isLoading runs before the guest attaches. The mount effect calls this
    // immediately, so guard like safeGetWebviewUrl/Title do.
    try {
      setIsLoading(Boolean(node.isLoading()));
    } catch {
      // Pre-dom-ready: keep the existing loading state.
    }
  }, [webviewNode]);

  useEffect(() => {
    const node = webviewNode;
    if (!node) return;

    const syncFromWebview = (
      url?: string,
      title?: string,
      options?: { iconUrl?: string; recordNavigation?: boolean; recordVisit?: boolean },
    ) => {
      const nextUrl = url || safeGetWebviewUrl(node);
      if (nextUrl) {
        setCurrentUrl(nextUrl);
        if (!addressEditing) {
          setAddressValue(nextUrl === EMPTY_URL ? '' : nextUrl);
        }
      }
      const nextTitle = title || safeGetWebviewTitle(node);
      if (nextUrl) {
        commitHistory(nextUrl, { iconUrl: options?.iconUrl, title: nextTitle }, { countVisit: options?.recordVisit === true });
        if (options?.recordNavigation !== false) {
          recordNavigation(nextUrl, nextTitle, { replacePendingTarget: true });
        } else {
          updateCurrentNavigationTitle(nextTitle);
        }
      }
      updateLoadingState(node);
    };
    const onStart = () => {
      setIsLoading(true);
      updateLoadingState(node);
    };
    const onStop = () => {
      setIsLoading(false);
      syncFromWebview(undefined, undefined, { recordVisit: false });
    };
    const onDomReady = () => {
      setWebContentsId(safeGetWebContentsId(node));
      onStop();
    };
    const onNavigate = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (navigationEvent.isMainFrame === false) return;
      const pendingTarget = pendingLoadTargetRef.current;
      const nextUrl = navigationEvent.url || safeGetWebviewUrl(node);
      const isPendingCommit = Boolean(pendingTarget && nextUrl && sameUrl(pendingTarget, nextUrl));
      syncFromWebview(nextUrl, undefined, { recordVisit: !isPendingCommit });
    };
    const onTitle = (event: Event) => {
      const titleEvent = event as WebviewTitleEvent;
      syncFromWebview(undefined, titleEvent.title, { recordNavigation: false, recordVisit: false });
    };
    const onFavicon = (event: Event) => {
      const faviconEvent = event as WebviewFaviconEvent;
      const iconUrl = faviconEvent.favicons?.find(isHttpLikeUrl);
      if (!iconUrl) return;
      syncFromWebview(undefined, undefined, { iconUrl, recordNavigation: false, recordVisit: false });
    };
    const onFail = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (navigationEvent.isMainFrame === false) return;
      setIsLoading(false);
      pendingLoadTargetRef.current = null;
      updateLoadingState(node);
    };

    node.addEventListener('did-start-loading', onStart);
    node.addEventListener('did-stop-loading', onStop);
    node.addEventListener('did-navigate', onNavigate);
    node.addEventListener('did-navigate-in-page', onNavigate);
    node.addEventListener('page-title-updated', onTitle);
    node.addEventListener('page-favicon-updated', onFavicon);
    node.addEventListener('did-fail-load', onFail);
    node.addEventListener('dom-ready', onDomReady);
    setWebContentsId(safeGetWebContentsId(node));
    updateLoadingState(node);
    return () => {
      node.removeEventListener('did-start-loading', onStart);
      node.removeEventListener('did-stop-loading', onStop);
      node.removeEventListener('did-navigate', onNavigate);
      node.removeEventListener('did-navigate-in-page', onNavigate);
      node.removeEventListener('page-title-updated', onTitle);
      node.removeEventListener('page-favicon-updated', onFavicon);
      node.removeEventListener('did-fail-load', onFail);
      node.removeEventListener('dom-ready', onDomReady);
    };
  }, [addressEditing, commitHistory, recordNavigation, updateCurrentNavigationTitle, updateLoadingState, webviewNode]);

  const suggestions = useMemo(() => {
    const query = addressValue.trim().toLocaleLowerCase();
    const showDefaultSuggestions = addressEditing && currentUrl !== EMPTY_URL && sameUrl(addressValue.trim(), currentUrl);
    const referenceSuggestions = REFERENCE_GROUPS.flatMap((group) =>
      group.sites.map((site) => ({
        detail: `${localizedReferenceGroupTitle(group, t)} - ${localizedReferenceSiteDetail(site, t)}`,
        id: `site:${site.url}`,
        iconUrl: referenceIconUrl(site.url),
        label: site.label,
        type: 'reference' as const,
        typeLabel: t('designBrowser.suggestion.reference'),
        url: site.url,
      })),
    );
    const historySuggestions = history.slice(0, HISTORY_SUGGESTION_LIMIT).map((entry) => ({
      detail: entry.url,
      id: `history:${entry.url}`,
      iconUrl: entry.iconUrl || faviconUrl(entry.url),
      label: entry.title || labelFromUrl(entry.url),
      type: 'history' as const,
      typeLabel: t('designBrowser.suggestion.history'),
      url: entry.url,
    }));
    const all = [...historySuggestions, ...referenceSuggestions];
    if (!query || showDefaultSuggestions) return all;
    return all
      .filter((item) =>
        `${item.label} ${item.url} ${item.detail}`.toLocaleLowerCase().includes(query),
      )
      .slice(0, HISTORY_SUGGESTION_LIMIT + referenceSuggestions.length);
  }, [addressEditing, addressValue, currentUrl, history, t]);

  const pageHistoryEntry = history.find((entry) => sameUrl(entry.url, currentUrl));
  const pageTitle = pageHistoryEntry?.title || restoredTitleRef.current || labelFromUrl(currentUrl);
  const pageIconUrl = pageHistoryEntry?.iconUrl || restoredIconUrlRef.current || faviconUrl(currentUrl);
  // Drive the start-page/webview branch off the load target, not the committed
  // URL, so a transient about:blank navigation event can't unmount the webview.
  useEffect(() => {
    if (!popupSurface || !popupViewport) return;
    let disposed = false;
    let lastVisible: boolean | null = null;
    let lastGeometry = '';
    let captureGeneration = 0;
    const present = async () => {
      const externalDialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"]')].find((element) => !element.closest('[aria-hidden="true"], [hidden]'));
      const occluded = Boolean(menuOpen || viewportMenuOpen || suggestionsOpen || browserUseOpen || browserDiagnosticsOpen || edgeAnnotationsOpen
        || drawOverlayOpen || activeCommentTarget || browserPreviewIndex !== null || externalDialog);
      const visible = browserTabActive && !occluded && document.visibilityState !== 'hidden';
      const rect = popupViewport.getBoundingClientRect();
      const geometry = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
      await popupSurface.present(visible);
      if (lastVisible !== visible || lastGeometry !== geometry) {
        lastVisible = visible;
        lastGeometry = geometry;
        const generation = ++captureGeneration;
        if (visible) setPopupPixels(null);
        else if (browserTabActive && occluded) {
          const image = await popupSurface.page.capturePage();
          if (!disposed && lastVisible === false && generation === captureGeneration) setPopupPixels(image.toDataURL());
        }
      }
    };
    popupPresentationRef.current = present;
    const refresh = () => { void present().catch(() => { /* A closing page has no surface to present. */ }); };
    const resize = new ResizeObserver(refresh); resize.observe(popupViewport);
    const mutation = new MutationObserver(refresh); mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'aria-hidden', 'class'] });
    window.addEventListener('resize', refresh); document.addEventListener('scroll', refresh, true);
    document.addEventListener('visibilitychange', refresh); refresh();
    return () => { disposed = true; if (popupPresentationRef.current === present) popupPresentationRef.current = null;
      resize.disconnect(); mutation.disconnect(); window.removeEventListener('resize', refresh);
      document.removeEventListener('scroll', refresh, true); document.removeEventListener('visibilitychange', refresh); void popupSurface.present(false).catch(() => {}); };
  }, [popupSurface, popupViewport, browserTabActive, menuOpen, viewportMenuOpen, suggestionsOpen, browserUseOpen, browserDiagnosticsOpen,
    edgeAnnotationsOpen, drawOverlayOpen, activeCommentTarget, browserPreviewIndex]);

  const isBlank = !popup && loadUrl === EMPTY_URL;
  const browserControlTarget = useMemo<EmbeddedBrowserTarget | null>(() => (
    desktopHostAvailable && browserTabId && webContentsId
      ? {
          active: browserTabActive,
          projectId,
          tabId: browserTabId,
          title: isBlank ? 'Browser' : pageTitle,
          url: isBlank ? EMPTY_URL : currentUrl,
          webContentsId,
        }
      : null
  ), [
    browserTabActive,
    browserTabId,
    currentUrl,
    desktopHostAvailable,
    isBlank,
    pageTitle,
    projectId,
    webContentsId,
  ]);
  const browserControlIdentity = browserControlTarget
    ? {
        tabId: browserControlTarget.tabId,
        webContentsId: browserControlTarget.webContentsId,
      }
    : null;

  const refreshBrowserDiagnostics = useCallback(async () => {
    if (!browserControlTarget || browserControlStatus !== 'connected') return;
    setBrowserDiagnosticsLoading(true);
    setBrowserDiagnosticsError(null);
    try {
      const options = {
        ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
        tabId: browserControlTarget.tabId,
        timeoutMs: 10_000,
      };
      const [network, consoleResult] = await Promise.all([
        executeEmbeddedBrowserOperation(
          projectId,
          { operation: 'network-list', limit: 50 },
          options,
        ),
        executeEmbeddedBrowserOperation(
          projectId,
          { operation: 'console', level: 'all', limit: 50 },
          options,
        ),
      ]);
      setBrowserDiagnostics({
        networkEntries: network.result.operation === 'network-list'
          ? network.result.entries.filter(isBrowserDiagnosticNetworkEntry)
          : [],
        consoleEntries: consoleResult.result.operation === 'console'
          ? consoleResult.result.entries.filter(isBrowserDiagnosticConsoleEntry)
          : [],
      });
    } catch (error) {
      setBrowserDiagnosticsError(
        error instanceof Error ? error.message : 'Browser diagnostics failed.',
      );
    } finally {
      setBrowserDiagnosticsLoading(false);
    }
  }, [browserControlStatus, browserControlTarget, projectId, workspaceContext]);

  useEffect(() => {
    if (!browserControlTarget) {
      setBrowserControlStatus('unavailable');
      return undefined;
    }
    const session = createEmbeddedBrowserControlSession({
      applyViewport,
      applyStyle,
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
      target: browserControlTarget,
      onStatus: (status) => {
        setBrowserControlStatus(status);
        if (!popup && browserTabId && status !== 'connecting') onBrowserRetentionChange?.(browserTabId, false);
      },
    });
    browserControlSessionRef.current = session;
    return () => {
      if (browserControlSessionRef.current === session) {
        browserControlSessionRef.current = null;
      }
      void session.stop();
    };
    // Mutable page metadata is renewed through updateTarget below; replacing
    // the session is reserved for a new physical guest/lease identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    browserControlTarget?.projectId,
    browserControlTarget?.tabId,
    browserControlTarget?.webContentsId,
    workspaceContext,
  ]);

  useEffect(() => {
    if (!browserControlTarget) return;
    browserControlSessionRef.current?.updateTarget(browserControlTarget);
  }, [browserControlTarget]);
  const addressDisplayParts = addressEditing
    ? { url: '' }
    : formatAddressDisplayParts(currentUrl, pageTitle);
  const shownAddressValue = addressEditing ? addressValue : '';
  const browserFilePath = isBlank ? browserCommentFilePath(EMPTY_URL) : browserCommentFilePath(currentUrl, resolvedDir);
  const editableProjectHtml = !isBlank && isProjectHtmlBrowserUrl(currentUrl, resolvedDir);
  const browserUseContext = useMemo<BrowserUsePromptContext>(() => ({
    browserFilePath,
    projectId,
    resolvedDir,
    tabLabel: isBlank ? 'Browser' : pageTitle,
    title: isBlank ? 'Browser' : pageTitle,
    url: isBlank ? EMPTY_URL : currentUrl,
  }), [browserFilePath, currentUrl, isBlank, pageTitle, projectId, resolvedDir]);
  const visibleComments = useMemo(
    () => previewComments
      .filter((comment) => comment.filePath === browserFilePath && comment.status === 'open')
      .sort((left, right) => left.createdAt - right.createdAt),
    [browserFilePath, previewComments],
  );
  const activeSavedComment = activePreviewCommentId
    ? visibleComments.find((comment) => comment.id === activePreviewCommentId) ?? null
    : null;
  // Saved pins are re-measured only while someone is looking at them: comment
  // tool on AND this browser tab active. Hidden tabs keep their <webview>
  // mounted, so without this gate every pinned page would run a whole-document
  // walk 4x/s forever. The effect keys off this joined string, never the
  // comments array, so a parent re-render cannot restart the poll.
  const savedPinTargetSignature = activeTool === 'comment' && browserTabActive
    ? browserPinTargetSignature(visibleComments)
    : '';

  useEffect(() => {
    const node = webviewNode;
    if (!node || isBlank) {
      setBrowserLiveCommentTargets((current) => (current.size > 0 ? new Map() : current));
      return;
    }

    const activeTarget = activeCommentTarget && browserTabActive
      ? [{
          elementId: activeCommentTarget.elementId,
          key: 'active',
          selector: activeCommentTarget.selector,
        }]
      : [];
    const targets = [...activeTarget, ...browserPinTargetsFromSignature(savedPinTargetSignature)]
      .filter((target) => target.elementId && target.selector);
    if (targets.length === 0) {
      setBrowserLiveCommentTargets((current) => (current.size > 0 ? new Map() : current));
      return;
    }

    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (cancelled || running || liveEditInFlightRef.current) return;
      running = true;
      const editRevision = liveEditRevisionRef.current;
      try {
        const result = await node.executeJavaScript<unknown>(
          browserMeasureTargetsScript(browserFilePath, targets),
          true,
        );
        if (cancelled || liveEditInFlightRef.current || editRevision !== liveEditRevisionRef.current || !Array.isArray(result)) return;
        const next = new Map<string, BrowserElementSnapshot>();
        for (const item of result) {
          if (!item || typeof item !== 'object') continue;
          const key = String((item as { key?: unknown }).key || '');
          if (!key) continue;
          const snapshot = browserSnapshotFromUnknown(item, browserFilePath);
          if (snapshot) next.set(key, snapshot);
        }
        setBrowserLiveCommentTargets((current) => (
          browserSnapshotMapsEqual(current, next) ? current : next
        ));
        const activeSnapshot = next.get('active');
        if (activeSnapshot) {
          setActiveCommentTarget((current) => (
            current && current.selector === activeSnapshot.selector && !browserSnapshotsEqual(current, activeSnapshot)
              ? { ...current, ...activeSnapshot }
              : current
          ));
        }
      } catch {
        // Cross-origin navigations, transient loads, and detached webviews can
        // reject executeJavaScript. Keep the saved positions until the next tick.
      } finally {
        running = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeCommentTarget?.elementId, activeCommentTarget?.selector, browserFilePath, browserTabActive, isBlank, savedPinTargetSignature, webviewNode]);

  useEffect(() => {
    const next = browserImages.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setBrowserImagePreviews(next);
    return () => {
      next.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [browserImages]);

  useEffect(() => {
    onPageInfoChange?.({
      title: isBlank ? 'Browser' : pageTitle,
      url: isBlank ? '' : currentUrl,
      ...(!isBlank && pageIconUrl ? { iconUrl: pageIconUrl } : {}),
    });
  }, [currentUrl, isBlank, onPageInfoChange, pageIconUrl, pageTitle]);

  useEffect(() => {
    pickerRequestIdRef.current += 1;
    setActiveTool(null);
    setActiveCommentTarget(null);
    setActivePreviewCommentId(null);
    setCommentDraft('');
    setQueuedCommentNotes([]);
    setBrowserImages([]);
    setBrowserPreviewIndex(null);
    setTextDraft('');
    void cancelBrowserPicker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserFilePath, projectId, conversationId]);

  async function handleAddressSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigateTo(addressValue);
    addressInputRef.current?.blur();
  }

  async function copyCurrentUrl() {
    const text = isBlank ? '' : currentUrl;
    if (!text) {
      setStatusMessage(t('designBrowser.status.noUrlToCopy'));
      return;
    }
    await copyText(text);
    setStatusMessage(t('designBrowser.status.urlCopied'));
    setMenuOpen(false);
  }

  async function openCurrentExternally() {
    if (isBlank || !isHttpLikeUrl(currentUrl)) {
      setStatusMessage(t('designBrowser.status.openHttpFirst'));
      return;
    }
    await openExternalUrl(currentUrl);
    setMenuOpen(false);
  }

  async function takeScreenshot() {
    if (!webviewNode || isBlank) {
      setStatusMessage(t('designBrowser.status.openBeforeScreenshot'));
      return;
    }
    setSavingAction('screenshot', true);
    // Close the dropdown first so it cannot appear in a host compositor capture
    // (which screenshots the on-screen window region, not the guest surface).
    setMenuOpen(false);
    if (drawOverlayOpen) flushSync(() => setCaptureChromeHidden(true));
    try {
      // Let the dropdown unmount + repaint before the compositor capture.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const dataUrl = await captureBrowserPageDataUrl();
      if (!dataUrl) throw new Error(t('designBrowser.status.screenshotFailed'));
      // Put the capture on the clipboard first so it is paste-ready (e.g. into
      // the chat composer) the instant it is taken; the project file is the
      // durable artifact, the clipboard is the fast path.
      const copied = await copyImageToClipboard(dataUrl);
      const base64 = dataUrl.split(',', 2)[1] ?? '';
      const file = await writeProjectBase64File(
        projectId,
        browserFileName('browser-capture', currentUrl, 'png'),
        base64,
        workspaceContext,
      );
      if (!file) throw new Error(t('designBrowser.status.screenshotFailed'));
      await onRefreshFiles();
      // Stay on the browser so the confirmation toast is visible and the page
      // remains in view; the capture is reachable from Design Files. Show
      // whether it reached the clipboard so the user knows it is paste-ready.
      setStatusMessage(
        copied
          ? t('fileViewer.screenshotCopied')
          : t('designBrowser.status.screenshotSaved'),
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t('designBrowser.status.screenshotFailed'));
    } finally {
      setCaptureChromeHidden(false);
      setSavingAction('screenshot', false);
      setMenuOpen(false);
    }
  }

  // Capture the live page as a PNG data URL. Prefers the desktop compositor
  // screenshot of the webview's on-screen region: the embedded <webview> guest
  // WebContents' own capturePage() frequently returns an all-black frame (its
  // GPU surface is not available to that capture path), whereas the host
  // window's composited surface clipped to the webview rect yields the real
  // page pixels the user sees — including authenticated content, since it is
  // the same logged-in session. Falls back to the guest capturePage() only when
  // no desktop host is present.
  async function captureBrowserPageDataUrl(): Promise<string | null> {
    const node = webviewNode;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const hostSnap = await captureHostRegionSnapshot({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    if (hostSnap) return hostSnap.dataUrl;
    try {
      const image = await node.capturePage();
      return image.toDataURL();
    } catch {
      return null;
    }
  }

  async function captureBrowserSnapshot(): Promise<{ dataUrl: string; w: number; h: number } | null> {
    if (!webviewNode || isBlank) return null;
    const rect = webviewNode.getBoundingClientRect();
    const hostSnap = await captureHostRegionSnapshot({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    if (hostSnap) return hostSnap;
    try {
      const image = await webviewNode.capturePage();
      const dataUrl = image.toDataURL();
      const size = await imageSizeFromDataUrl(dataUrl);
      if (size) return { dataUrl, ...size };
      const dpr = window.devicePixelRatio || 1;
      return {
        dataUrl,
        w: Math.max(1, Math.round(rect.width * dpr)),
        h: Math.max(1, Math.round(rect.height * dpr)),
      };
    } catch {
      return null;
    }
  }

  function diagnoseAnnotationCapture(phase: string, reason: string, started: number,
    dimensions: Record<string, number | undefined> = {}) {
    if (annotationCaptureDiagnosticsRef.current++ >= 20) return;
    console.warn(JSON.stringify({ logger: 'browser.annotation.capture', mode: popupSurface ? 'popup' : 'ordinary',
      phase, reason, elapsedMs: Math.round(performance.now() - started),
      ...Object.fromEntries(Object.entries(dimensions).filter(([, value]) => Number.isFinite(value))) }));
  }

  // `onPixelsCaptured` fires once the page pixels are held, so the caller can
  // reveal its hidden chrome before the slower masking and encoding run.
  async function captureBrowserElementAnnotation(
    target: BrowserElementSnapshot,
    onPixelsCaptured?: () => void,
  ): Promise<File | null> {
    const started = performance.now();
    let phase = 'initial';
    const reject = (reason: string, dimensions?: Record<string, number | undefined>) => {
      diagnoseAnnotationCapture('rejected', reason, started, dimensions); return null;
    };
    const node = webviewNode;
    diagnoseAnnotationCapture('started', 'capture-requested', started, { maskCount: target.maskRects?.length,
      targetWidth: target.position.width, targetHeight: target.position.height,
      viewportWidth: target.viewport?.width, viewportHeight: target.viewport?.height });
    if (!node) return reject('node-unavailable');
    if (!target.maskRects) return reject('masks-unavailable');
    if (!target.viewport) return reject('viewport-unavailable');
    const initialUrl = node.getURL?.() || currentUrl;
    const frame = node.getBoundingClientRect();
    if (Math.abs(frame.width - target.viewport.width) > 1
      || Math.abs(frame.height - target.viewport.height) > 1) return reject('frame-viewport-mismatch',
        { frameWidth: frame.width, frameHeight: frame.height });
    // The picture frames the whole visible element, plus page context when it
    // is tiny, flat or narrow, so the pin stays recognisable in a thumbnail.
    // Frame inside the page's content box: a guest scrollbar is not page content.
    const framing = pinCaptureFrame(target.position, {
      width: Math.min(frame.width, target.viewport.contentWidth ?? frame.width),
      height: Math.min(frame.height, target.viewport.contentHeight ?? frame.height),
    });
    if (!framing) return reject('target-outside-frame');
    const left = frame.left + framing.frame.x;
    const top = frame.top + framing.frame.y;
    const right = left + framing.frame.width;
    const bottom = top + framing.frame.height;

    const hideText = target.maskRects.some((mask) => mask.textHidden === true);
    try {
      phase = 'hide-text';
      if (hideText && await node.executeJavaScript<boolean>(browserAnnotationTextPaintScript(true), true) !== true) return reject('text-hide-failed');
      phase = 'paint';
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      phase = 'measure-before';
      const before = browserSnapshotFromUnknown(await node.executeJavaScript<unknown>(
        browserMeasureTargetsScript(target.filePath, [{ elementId: target.elementId,
          selector: target.selector, key: 'capture' }]), true,
      ).then((items) => Array.isArray(items) ? items[0] : null).catch(() => null), target.filePath);
      const beforeRejection = !before?.maskRects ? 'before-masks-unavailable' : !before.viewport ? 'before-viewport-unavailable'
        : before.selector !== target.selector ? 'before-selector-changed'
        : (node.getURL?.() || currentUrl) !== initialUrl ? 'before-url-changed'
        : JSON.stringify(before.position) !== JSON.stringify(target.position) ? 'before-position-changed'
        : JSON.stringify(before.maskRects) !== JSON.stringify(target.maskRects) ? 'before-masks-changed'
        : JSON.stringify(before.viewport) !== JSON.stringify(target.viewport) ? 'before-viewport-changed' : null;
      if (beforeRejection) return reject(beforeRejection, { measuredWidth: before?.viewport?.width, measuredHeight: before?.viewport?.height });
      let snapshot: PreviewSnapshot | null;
      let actualCrop: { x: number; y: number; width: number; height: number } | undefined;
      phase = 'capture';
      if (popupSurface) {
        // The host region contains the popup's placeholder, not its native
        // WebContentsView. Crop only the owned child's decoded pixel surface.
        const dataUrl = (await node.capturePage()).toDataURL();
        phase = 'decode';
        const size = await imageSizeFromDataUrl(dataUrl);
        if (!size) return reject('child-decode-failed');
        phase = 'crop';
        snapshot = await cropDataUrl(dataUrl,
          (left - frame.left) * size.w / frame.width,
          (top - frame.top) * size.h / frame.height,
          (right - left) * size.w / frame.width,
          (bottom - top) * size.h / frame.height);
        actualCrop = framing.frame;
      } else {
        snapshot = await captureHostRegionSnapshot({ left, top, width: right - left, height: bottom - top });
        if (snapshot?.capturedCssRect) {
          const captured = snapshot.capturedCssRect;
          actualCrop = { x: captured.x - frame.left, y: captured.y - frame.top,
            width: captured.width, height: captured.height };
        } else if (snapshot && target.maskRects.length > 0) return reject('capture-geometry-unavailable');
      }
      if (!snapshot && !popupSurface) {
        // A full-frame fallback would discard the exact cropped CSS origin.
        if (target.maskRects.length > 0) return reject('capture-geometry-unavailable');
        phase = 'fallback-capture';
        const page = await captureBrowserSnapshot();
        if (!page) return reject('fallback-capture-unavailable');
        phase = 'crop';
        const scaleX = page.w / Math.max(1, frame.width);
        const scaleY = page.h / Math.max(1, frame.height);
        snapshot = await cropDataUrl(
          page.dataUrl,
          (left - frame.left) * scaleX,
          (top - frame.top) * scaleY,
          (right - left) * scaleX,
          (bottom - top) * scaleY,
        );
      }
      if (!snapshot) return reject('capture-crop-unavailable');
      diagnoseAnnotationCapture('captured', 'pixels-available', started, { imageWidth: snapshot.w, imageHeight: snapshot.h });
      onPixelsCaptured?.();
      phase = 'verify-text';
      if (hideText && await node.executeJavaScript<boolean>(browserAnnotationTextPaintScript(true, true), true) !== true) return reject('text-hide-verification-failed');
      phase = 'measure-after';
      const after = browserSnapshotFromUnknown(await node.executeJavaScript<unknown>(
        browserMeasureTargetsScript(target.filePath, [{ elementId: target.elementId,
          selector: target.selector, key: 'capture' }]), true,
      ).then((items) => Array.isArray(items) ? items[0] : null).catch(() => null), target.filePath);
      const afterRejection = !after?.maskRects ? 'after-masks-unavailable' : !after.viewport ? 'after-viewport-unavailable'
        : after.selector !== target.selector ? 'after-selector-changed'
        : (node.getURL?.() || currentUrl) !== initialUrl ? 'after-url-changed'
        : JSON.stringify(after.position) !== JSON.stringify(before!.position) ? 'after-position-changed'
        : JSON.stringify(after.maskRects) !== JSON.stringify(before!.maskRects) ? 'after-masks-changed'
        : JSON.stringify(after.viewport) !== JSON.stringify(before!.viewport) ? 'after-viewport-changed' : null;
      if (afterRejection) return reject(afterRejection, { measuredWidth: after?.viewport?.width, measuredHeight: after?.viewport?.height });
      phase = 'mask';
      const captureRect = actualCrop ?? framing.frame;
      const pixelMasks = browserAnnotationPixelMasks(target.position,
        { x: 0, y: 0, width: frame.width, height: frame.height }, snapshot, target.maskRects, captureRect);
      if (!pixelMasks) return reject('pixel-masks-invalid');
      snapshot = await maskBrowserAnnotationSnapshot(snapshot, pixelMasks);
      if (!snapshot) return reject('pixel-masking-failed');
      // Ring the element when context was added; otherwise trim plain empty
      // margins. Either step keeps the plain picture if it cannot run.
      phase = 'frame';
      const pixelsPerCss = snapshot.w / Math.max(1, captureRect.width);
      snapshot = framing.highlight
        ? await outlinePinCapture(snapshot, {
          x: (framing.frame.x + framing.highlight.x - captureRect.x) * pixelsPerCss,
          y: (framing.frame.y + framing.highlight.y - captureRect.y) * pixelsPerCss,
          width: framing.highlight.width * pixelsPerCss,
          height: framing.highlight.height * pixelsPerCss,
        }, pixelsPerCss)
        : await trimPinCapture(snapshot, pixelsPerCss);
      // Keep chat crops bounded on high-DPI displays; large images must not turn
      // an otherwise valid note into a rejected post.
      for (let maxEdge = 1200; maxEdge >= 150; maxEdge = Math.floor(maxEdge / 2)) {
        phase = 'resize';
        snapshot = await cropDataUrl(snapshot.dataUrl, 0, 0, snapshot.w, snapshot.h, maxEdge);
        if (!snapshot) return reject('bounded-resize-failed');
        if (snapshot.dataUrl.length <= 4 * Math.ceil(256 * 1024 / 3) + 22) break;
      }
      if (snapshot.dataUrl.length > 4 * Math.ceil(256 * 1024 / 3) + 22) return reject('image-too-large');
      phase = 'blob';
      const blob = await fetch(snapshot.dataUrl).then((response) => response.blob());
      diagnoseAnnotationCapture('completed', 'file-ready', started, { imageWidth: snapshot.w, imageHeight: snapshot.h, bytes: blob.size });
      return new File(
        [blob],
        `browser-annotation-${Date.now()}.png`,
        { type: blob.type || 'image/png' },
      );
    } catch (error) {
      diagnoseAnnotationCapture('exception', phase, started); throw error;
    } finally {
      if (hideText) await node.executeJavaScript(browserAnnotationTextPaintScript(false), true).catch(() => {});
    }
  }

  const addBrowserImageToChat = useCallback(async (payload: {
    alt?: string;
    height: number;
    src?: string;
    width: number;
    x: number;
    y: number;
  }) => {
    const node = webviewNode;
    if (!node || !onAddImageToChat) return;
    const frame = node.getBoundingClientRect();
    const left = Math.max(frame.left, frame.left + payload.x);
    const top = Math.max(frame.top, frame.top + payload.y);
    const right = Math.min(frame.right, frame.left + payload.x + payload.width);
    const bottom = Math.min(frame.bottom, frame.top + payload.y + payload.height);
    if (right <= left || bottom <= top) return;

    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      let snapshot = await captureHostRegionSnapshot({
        left,
        top,
        width: right - left,
        height: bottom - top,
      });
      if (!snapshot) {
        // Host compositor region grab unavailable (returns null on some
        // setups even when the full-frame grab works). Fall back to the
        // guest's own capturePage() and crop to the image's rect — the same
        // guest fallback captureBrowserSnapshot() uses, so the "添加到对话"
        // path is as robust as the full-frame capture.
        try {
          const guestUrl = (await node.capturePage()).toDataURL();
          const dpr = window.devicePixelRatio || 1;
          snapshot = await cropDataUrl(
            guestUrl,
            (left - frame.left) * dpr,
            (top - frame.top) * dpr,
            (right - left) * dpr,
            (bottom - top) * dpr,
          );
        } catch {
          snapshot = null;
        }
      }
      if (!snapshot) throw new Error(t('designBrowser.status.screenshotFailed'));

      animateImageIntoChat(snapshot.dataUrl, { left, top, width: right - left, height: bottom - top });
      const base64 = snapshot.dataUrl.split(',', 2)[1] ?? '';
      const file = await writeProjectBase64File(
        projectId,
        browserFileName('chat-image', currentUrl, 'png'),
        base64,
        workspaceContext,
      );
      if (!file) throw new Error(t('designBrowser.status.screenshotFailed'));
      await onRefreshFiles();
      onAddImageToChat({
        path: file.path || file.name,
        name: payload.alt?.trim() || file.name.split('/').pop() || file.name,
        kind: 'image',
        size: file.size,
      });
      setStatusMessage(t('designBrowser.status.imageAddedToChat'));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t('designBrowser.status.screenshotFailed'));
    }
  }, [currentUrl, onAddImageToChat, onRefreshFiles, projectId, t, webviewNode, workspaceContext]);

  useEffect(() => {
    const node = webviewNode;
    if (!node || !onAddImageToChat || isBlank) return;

    const injectHoverLayer = () => {
      // executeJavaScript throws synchronously until the webview emits
      // dom-ready; the dom-ready/did-stop-loading listeners re-inject then.
      try {
        void node.executeJavaScript(
          browserImageHoverScript(t('designBrowser.addImageToChatButton')),
          true,
        ).catch(() => undefined);
      } catch {
        // Webview not attached/ready yet.
      }
    };
    const onConsoleMessage = (event: Event) => {
      const message = (event as WebviewConsoleMessageEvent).message ?? '';
      if (!message.startsWith(ADD_IMAGE_TO_CHAT_MESSAGE)) return;
      try {
        const payload = JSON.parse(message.slice(ADD_IMAGE_TO_CHAT_MESSAGE.length)) as {
          alt?: string;
          height?: number;
          src?: string;
          width?: number;
          x?: number;
          y?: number;
        };
        if (
          !Number.isFinite(payload.x) || !Number.isFinite(payload.y) ||
          !Number.isFinite(payload.width) || !Number.isFinite(payload.height) ||
          Number(payload.width) <= 0 || Number(payload.height) <= 0
        ) return;
        void addBrowserImageToChat({
          alt: payload.alt,
          height: Number(payload.height),
          src: payload.src,
          width: Number(payload.width),
          x: Number(payload.x),
          y: Number(payload.y),
        });
      } catch {
        // Ignore unrelated or malformed guest console messages.
      }
    };

    node.addEventListener('dom-ready', injectHoverLayer);
    node.addEventListener('did-stop-loading', injectHoverLayer);
    node.addEventListener('console-message', onConsoleMessage);
    injectHoverLayer();
    return () => {
      node.removeEventListener('dom-ready', injectHoverLayer);
      node.removeEventListener('did-stop-loading', injectHoverLayer);
      node.removeEventListener('console-message', onConsoleMessage);
    };
  }, [addBrowserImageToChat, isBlank, onAddImageToChat, t, webviewNode]);

  async function savePageBrief() {
    if (!webviewNode || isBlank) {
      setStatusMessage(t('designBrowser.status.openBeforeBrief'));
      return;
    }
    setSavingAction('brief', true);
    try {
      const brief = await webviewNode.executeJavaScript<PageBrief>(PAGE_BRIEF_SCRIPT, true);
      const file = await writeProjectTextFile(
        projectId,
        browserFileName('browser-brief', currentUrl, 'md'),
        pageBriefMarkdown(brief, currentUrl),
        undefined,
        workspaceContext,
      );
      if (!file) throw new Error(t('designBrowser.status.briefSaveFailed'));
      await onRefreshFiles();
      onOpenFile(file.name);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t('designBrowser.status.briefSaveFailed'));
    } finally {
      setSavingAction('brief', false);
      setMenuOpen(false);
    }
  }

  async function savePageSnapshot(
    options: { openAfterSave?: boolean } = {},
  ): Promise<BrandBrowserPageSnapshotResult> {
    if (!webviewNode || isBlank) {
      const message = t('designBrowser.status.openBeforeDownload');
      setStatusMessage(message);
      return { ok: false, message };
    }
    const controller = new AbortController();
    const run = {
      controller,
      id: archiveRunIdRef.current + 1,
      startedAt: Date.now(),
    };
    archiveRunIdRef.current = run.id;
    archiveRunRef.current = run;
    setArchiveElapsedSeconds(0);
    setSavingAction('archive', true);
    setDownloadAttentionNonce(null);
    setMenuOpen(false);
    // A page that never finishes loading (perpetual spinner) leaves the
    // capture waiting forever. Halt the pending load first so we snapshot the
    // DOM that already rendered instead of blocking on a load that may never
    // settle — what the user would otherwise do by hand via the Stop button.
    stopLoading();
    setStatusMessage({
      message: t('designBrowser.status.pageSnapshotStarted'),
      source: 'page-snapshot',
    });
    try {
      const capture = await abortablePageSnapshotPromise(
        webviewNode.executeJavaScript<BrowserPageArchiveCapture>(
          BROWSER_CAPTURE_PAGE_ARCHIVE_SCRIPT,
          true,
        ),
        controller.signal,
      );
      if (!isBrowserPageArchiveCapture(capture)) {
        throw new Error(t('designBrowser.status.pageSnapshotUnsupported'));
      }
      const dir = browserPageArchiveDir(currentUrl);
      const htmlFile = `${dir}/page.html`;
      const cssFile = `${dir}/styles.css`;
      const manifestFile = `${dir}/manifest.json`;
      const htmlSaved = await abortablePageSnapshotPromise(
        writeProjectTextFile(projectId, htmlFile, capture.html, undefined, workspaceContext),
        controller.signal,
      );
      if (!htmlSaved) throw new Error(t('designBrowser.status.pageSnapshotFailed'));
      const cssSaved = await abortablePageSnapshotPromise(
        writeProjectTextFile(projectId, cssFile, capture.css ?? '', undefined, workspaceContext),
        controller.signal,
      );
      if (!cssSaved) throw new Error(t('designBrowser.status.pageSnapshotFailed'));

      // The snapshot's only consumer is design-system extraction, which reads
      // back nothing but page.html + styles.css (see ProjectView's
      // readLocalBrowserPageArchiveSnapshot → extract-from-html, which POSTs
      // only { html, css, baseUrl }). The daemon then harvests logos/fonts
      // itself, server-side, from refs inside that HTML/CSS. Downloading the
      // page's images/fonts/scripts/video here added nothing extraction reads
      // yet cost a 12s+ fan-out, so we persist the two text files and stop.
      const manifest: BrowserPageArchiveManifest = {
        schema: BROWSER_PAGE_ARCHIVE_SCHEMA,
        capturedAt: Date.now(),
        title: capture.title || pageTitle,
        url: capture.url || currentUrl,
        baseUrl: capture.url || currentUrl,
        htmlFile,
        cssFile,
        manifestFile,
        resources: [],
      };
      const manifestText = JSON.stringify(manifest, null, 2);
      const savedManifest = await abortablePageSnapshotPromise(
        writeProjectTextFile(projectId, manifestFile, manifestText, undefined, workspaceContext),
        controller.signal,
      );
      const savedIndex = await abortablePageSnapshotPromise(
        writeProjectTextFile(projectId, BROWSER_PAGE_ARCHIVE_INDEX_FILE, manifestText, undefined, workspaceContext),
        controller.signal,
      );
      if (!savedManifest || !savedIndex) throw new Error(t('designBrowser.status.pageSnapshotFailed'));
      await abortablePageSnapshotPromise(Promise.resolve(onRefreshFiles()), controller.signal);
      if (options.openAfterSave !== false) onOpenFile(manifestFile);
      const message = t('designBrowser.status.pageSnapshotSaved');
      const elapsedSeconds = pageSnapshotRunElapsedSeconds(run);
      const canOpenDesignFiles = Boolean(onOpenDesignFiles);
      setStatusMessage({
        actionFileName: manifestFile,
        actionLabel: canOpenDesignFiles
          ? t('designBrowser.status.viewDesignFiles')
          : t('workspace.designFiles'),
        actionTarget: canOpenDesignFiles ? 'design-files' : 'file',
        message,
        source: 'page-snapshot',
      });
      emitPageSnapshotToast({
        actionFileName: manifestFile,
        actionLabel: t('designBrowser.status.viewDesignFiles'),
        actionTarget: 'design-files',
        elapsedSeconds,
        message,
        status: 'success',
        ttlMs: 8000,
      });
      return {
        ok: true,
        baseUrl: manifest.baseUrl,
        cssFile,
        htmlFile,
        indexFile: BROWSER_PAGE_ARCHIVE_INDEX_FILE,
        manifestFile,
        message,
      };
    } catch (error) {
      const canceled = isPageSnapshotAbortError(error) || controller.signal.aborted;
      const message = canceled
        ? t('designs.status.canceled')
        : error instanceof Error ? error.message : t('designBrowser.status.pageSnapshotFailed');
      const elapsedSeconds = pageSnapshotRunElapsedSeconds(run);
      setStatusMessage({
        message,
        source: 'page-snapshot',
      });
      emitPageSnapshotToast({
        elapsedSeconds,
        message,
        status: canceled ? 'canceled' : 'error',
        ttlMs: canceled ? 3000 : 8000,
      });
      return { ok: false, message };
    } finally {
      if (archiveRunRef.current?.id === run.id) {
        archiveRunRef.current = null;
        setSavingAction('archive', false);
        setMenuOpen(false);
      }
    }
  }

  async function clearCookies(storage: boolean) {
    if (!desktopHostAvailable) {
      setStatusMessage(t('designBrowser.status.desktopDataUnavailable'));
      return;
    }
    const result = await clearHostBrowserData({ cookies: true, storage });
    setStatusMessage(
      result.ok
        ? t('designBrowser.status.browserDataCleared')
        : 'reason' in result
          ? result.reason
          : t('designBrowser.status.browserDataClearFailed'),
    );
    if (storage) {
      setHistory([]);
      setLoadUrl(EMPTY_URL);
      setCurrentUrl(EMPTY_URL);
      setAddressValue('');
      setAddressEditing(false);
      setNavigationState([browserHomeNavigationEntry()], 0);
      pendingLoadTargetRef.current = null;
      saveHistory(projectId, []);
    }
    setMenuOpen(false);
  }

  function clearHistoryOnly() {
    setHistory([]);
    saveHistory(projectId, []);
    setStatusMessage(t('designBrowser.status.historyCleared'));
    setMenuOpen(false);
  }

  function navigateHistoryBy(delta: -1 | 1) {
    if (popup && webviewNode) {
      if (delta < 0 && popup.canGoBack) webviewNode.goBack();
      else if (delta > 0 && popup.canGoForward) webviewNode.goForward();
      return;
    }
    const targetIndex = navigationIndex + delta;
    const entry = navigationStack[targetIndex];
    if (!entry) return;
    pendingLoadTargetRef.current = null;
    setNavigationState(navigationStack.slice(), targetIndex);
    setCurrentUrl(entry.url);
    setAddressValue(entry.url === EMPTY_URL ? '' : entry.url);
    setAddressEditing(false);
    setSuggestionsOpen(false);
    setMenuOpen(false);
    if (entry.url === EMPTY_URL) {
      pendingLoadTargetRef.current = null;
      setLoadUrl(EMPTY_URL);
      return;
    }
    if (webviewNode && canUseNativeHistoryNavigation(webviewNode, delta)) {
      if (delta < 0) webviewNode.goBack();
      else webviewNode.goForward();
    } else {
      loadWebviewUrl(entry.url);
    }
  }

  function reload(hard = false) {
    if (isBlank) return;
    if (webviewNode) {
      // Reload is enabled as soon as a URL is set, which can be before the
      // <webview> emits dom-ready; reload()/reloadIgnoringCache() throw in that
      // window. Guard so an early click can't crash the panel.
      try {
        if (hard) webviewNode.reloadIgnoringCache();
        else webviewNode.reload();
      } catch {
        setLoadUrl((url) => `${url}${url.includes('?') ? '&' : '?'}odReload=${Date.now()}`);
      }
    } else {
      setLoadUrl((url) => `${url}${url.includes('?') ? '&' : '?'}odReload=${Date.now()}`);
    }
    setMenuOpen(false);
  }

  // Halt any pending navigation/load, the way Chrome's address-bar X does. A
  // page stuck mid-load (perpetual spinner) otherwise blocks the user from
  // acting on what already rendered — and can wedge the snapshot capture below.
  function stopLoading() {
    if (!webviewNode) return;
    try {
      // <webview>.stop() throws if the guest hasn't attached yet; guard like
      // reload() does.
      webviewNode.stop?.();
    } catch {
      // Pre-dom-ready: nothing to stop.
    }
    setIsLoading(false);
  }

  async function cancelBrowserPicker() {
    pickerRequestIdRef.current += 1;
    try {
      await webviewNode?.executeJavaScript(BROWSER_CANCEL_PICKER_SCRIPT, true);
    } catch {
      // The picker script only exists after a page is loaded; ignore misses.
    }
  }

  function clearBrowserTool() {
    void cancelBrowserPicker();
    setActiveTool(null);
    setActiveCommentTarget(null);
    setActivePreviewCommentId(null);
    setCommentDraft('');
    setQueuedCommentNotes([]);
    setBrowserImages([]);
    setBrowserPreviewIndex(null);
    setTextDraft('');
  }

  /**
   * Closes the pin popover (Close button / Escape). The comment tool stays on
   * and the panel returns to pick mode, so the badges and dock stay mounted
   * and keyboard focus can go back to the control the pin was opened from
   * (badge or dock row), else to the toolbar toggle. Turning the tool off is
   * the toolbar toggle's job, not the popover's.
   */
  function closeBrowserCommentPopover() {
    const root = rootRef.current;
    const id = activePreviewCommentId;
    const badge = id ? root?.querySelector<HTMLElement>(`[data-testid="db-comment-marker-${CSS.escape(id)}"] button`) : null;
    const row = id ? root?.querySelector<HTMLElement>(`.comment-side-item[data-comment-id="${CSS.escape(id)}"]`) : null;
    const ordered = pinOpenOriginRef.current === 'badge' ? [badge, row] : [row, badge];
    const focusTarget = ordered.find(Boolean) ?? root?.querySelector<HTMLElement>('.db-action-annotate button') ?? null;
    pinOpenOriginRef.current = null;
    void pickBrowserElement('comment');
    focusTarget?.focus();
  }

  /** Opens a saved pin (marker badge or dock row) in the popover for editing.
   *  Any in-flight element pick or capture belongs to the previous selection
   *  and is dropped by bumping the picker request id. */
  function openSavedBrowserComment(comment: PreviewComment, origin: 'badge' | 'dock' = 'dock') {
    void cancelBrowserPicker();
    pinOpenOriginRef.current = origin;
    // A capture still settling for the previous pick must not become this
    // pin's screenshot on Save.
    captureCleanupRef.current = null;
    // Saved pins are measured position-only, so take the live geometry and
    // keep the row's text/style; the `active` poll refreshes both shortly.
    const live = browserLiveCommentTargets.get(`comment:${comment.id}`);
    const stored = browserSnapshotFromComment(comment, browserFilePath);
    const snapshot = live
      ? { ...stored, position: live.position, ...(live.viewport ? { viewport: live.viewport } : {}) }
      : stored;
    setActiveTool('comment');
    setActiveCommentTarget(snapshot);
    setActivePreviewCommentId(comment.id);
    setCommentDraft(comment.note);
    setQueuedCommentNotes([]);
    setBrowserImages([]);
    setBrowserPreviewIndex(null);
    setTextDraft(snapshot.text);
  }

  async function pickBrowserElement(tool: BrowserTool) {
    if (isBlank || !webviewNode) {
      setStatusMessage(t('designBrowser.status.openPageBeforeTools'));
      return;
    }
    const requestId = pickerRequestIdRef.current + 1;
    pickerRequestIdRef.current = requestId;
    setActiveTool(tool);
    setActiveCommentTarget(null);
    setActivePreviewCommentId(null);
    setCommentDraft('');
    setQueuedCommentNotes([]);
    setBrowserImages([]);
    setBrowserPreviewIndex(null);
    setTextDraft('');
    setDrawOverlayOpen(false);
    setMenuOpen(false);
    setStatusMessage(
      tool === 'comment'
        ? t('designBrowser.status.clickElementToComment')
        : t('designBrowser.status.clickElementToTune'),
    );
    try {
      await webviewNode.executeJavaScript(BROWSER_CANCEL_PICKER_SCRIPT, true);
      const result = await webviewNode.executeJavaScript<unknown>(
        browserElementPickerScript(browserFilePath),
        true,
      );
      if (pickerRequestIdRef.current !== requestId) return;
      const snapshot = browserSnapshotFromUnknown(result, browserFilePath);
      if (!snapshot) {
        setStatusMessage(t('designBrowser.status.noElementSelected'));
        setActiveTool(null);
        return;
      }
      // Commit the hidden chrome (popover, pin markers, status toast) together
      // with the new target before capture starts: a hide that lands after the
      // capture's paint wait lets the compositor grab the popover.
      flushSync(() => {
        setActiveCommentTarget(snapshot);
        setTextDraft(snapshot.text);
        setActiveTool(tool);
        if (tool === 'comment') setCaptureChromeHidden(true);
      });
      if (tool === 'comment') {
        const captureStarted = performance.now();
        let captureTimeout: ReturnType<typeof setTimeout>;
        const deadline = new Promise<null>((resolve) => { captureTimeout = setTimeout(() => {
          diagnoseAnnotationCapture('timeout', 'capture-deadline', captureStarted); resolve(null);
        }, BROWSER_CAPTURE_DEADLINE_MS); });
        // Unhide as soon as the pixels are taken; a superseded pick keeps its own hide.
        const capture = captureBrowserElementAnnotation(snapshot, () => {
          if (pickerRequestIdRef.current === requestId) setCaptureChromeHidden(false);
        }).finally(() => {
          if (captureCleanupRef.current === capture) captureCleanupRef.current = null;
        });
        captureCleanupRef.current = capture;
        void Promise.race([capture, deadline]).then((file) => {
          diagnoseAnnotationCapture('result', file ? 'file-available' : 'no-file', captureStarted);
          if (file && pickerRequestIdRef.current === requestId) {
            setBrowserImages([file]);
            diagnoseAnnotationCapture('attached', 'image-staged', captureStarted, { bytes: file.size });
          } else if (file) {
            diagnoseAnnotationCapture('discarded', 'request-superseded', captureStarted);
          }
        }).catch(() => { diagnoseAnnotationCapture('result', 'capture-exception', captureStarted); })
          .finally(() => { clearTimeout(captureTimeout); setCaptureChromeHidden(false); });
      }
      setStatusMessage(
        tool === 'comment'
          ? t('designBrowser.status.addBrowserComment')
          : editableProjectHtml
            ? t('designBrowser.status.tuneElementThenSaveHtml')
            : t('designBrowser.status.tuneLiveOnly'),
      );
    } catch (error) {
      if (pickerRequestIdRef.current !== requestId) return;
      setStatusMessage(error instanceof Error ? error.message : t('designBrowser.status.pickerFailed'));
      setActiveTool(null);
    }
  }

  function toggleBrowserTool(tool: BrowserTool) {
    if (activeTool === tool) {
      clearBrowserTool();
      return;
    }
    void pickBrowserElement(tool);
  }

  function requestBrowserUsePrompt(action: BrowserUseAction) {
    if (!onRequestBrowserUsePrompt) {
      setStatusMessage(t('browserUse.unavailable'));
      setBrowserUseOpen(false);
      return;
    }
    onRequestBrowserUsePrompt(browserUsePrompt(action, browserUseContext));
    setBrowserUseOpen(false);
    setMenuOpen(false);
    setSuggestionsOpen(false);
    setStatusMessage(t('browserUse.added'));
  }

  async function applyMeasuredBrowserEdit(selector: string, script: string, expiresAt: number): Promise<JsonValue> {
    const node = webviewNode;
    if (!node || !browserActiveRef.current) throw new Error('Activate this browser tab before editing');
    const target = activeCommentTargetRef.current;
    const selected = target?.selector === selector ? target : null;
    const pageUrl = node.getURL?.() || currentUrl;
    const revision = ++liveEditRevisionRef.current;
    const selection = ++pickerRequestIdRef.current;
    liveEditInFlightRef.current = true;
    // A capture deadline can settle before its paint suppression cleanup.
    // Invalidate its attachment first, then await the underlying finalizer.
    setBrowserImages((files) => files.filter((file) => !file.name.startsWith('browser-annotation-')));
    setApplyingBrowserEdit(true);
    const available = () => revision === liveEditRevisionRef.current && selection === pickerRequestIdRef.current
      && node === currentWebviewRef.current && browserActiveRef.current && Date.now() < expiresAt
      && (node.getURL?.() || currentUrl) === pageUrl
      && (!selected || activeCommentTargetRef.current?.elementId === selected.elementId);
    try {
      await captureCleanupRef.current;
      if (!available()) throw new Error('Browser selection changed or command expired');
      if (await node.executeJavaScript(script, true) !== true) throw new Error('Browser edit was not applied');
      if (!available()) throw new Error('Browser selection changed or command expired');
      const result = await node.executeJavaScript<unknown>(browserMeasureTargetsScript(browserFilePath, [{
        key: 'live-edit', selector, elementId: selected?.elementId ?? `dom:${selector}`,
      }]), true);
      const measured = Array.isArray(result) ? browserSnapshotFromUnknown(result[0], browserFilePath) : null;
      if (!measured || measured.selector !== selector || !available()) throw new Error('Browser edit could not be measured');
      if (selected) {
        activeCommentTargetRef.current = measured;
        setActiveCommentTarget(measured);
      }
      return measured as unknown as JsonValue;
    } finally {
      if (revision === liveEditRevisionRef.current) {
        liveEditInFlightRef.current = false;
        setApplyingBrowserEdit(false);
      }
    }
  }

  applyStyleRef.current = async (request, expiresAt = Date.now() + 30_000) => {
    if (!isBrowserStylePatch(request.styles)) throw new Error('Invalid browser style patch');
    return applyMeasuredBrowserEdit(request.target.selector, browserApplyStylesScript(request.target.selector, request.styles), expiresAt);
  };

  async function applyBrowserStyle(prop: keyof PreviewAnnotationStyle, value: string, allPaddingSides = true) {
    const target = activeCommentTargetRef.current;
    if (!target) return;
    const styles: Partial<PreviewAnnotationStyle> = prop === 'paddingTop' && allPaddingSides
      ? { paddingTop: value, paddingRight: value, paddingBottom: value, paddingLeft: value }
      : { [prop]: value };
    try {
      if (!browserTabId || browserControlStatus !== 'connected') throw new Error('Browser control is not connected');
      setApplyingBrowserEdit(true);
      await executeEmbeddedBrowserOperation(projectId, { operation: 'style', approved: true,
        target: { selector: target.selector }, styles }, { tabId: browserTabId,
        ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}) });
    } catch {
      setStatusMessage(t('designBrowser.status.applyStyleFailed'));
    } finally { setApplyingBrowserEdit(false); }
  }

  async function applyBrowserText(value: string) {
    const target = activeCommentTargetRef.current;
    if (!target) return;
    setTextDraft(value);
    try {
      await applyMeasuredBrowserEdit(target.selector, browserApplyTextScript(target.selector, value), Date.now() + 30_000);
    } catch {
      setStatusMessage(t('designBrowser.status.editTextFailed'));
    }
  }

  async function saveBrowserDomEdit() {
    if (!webviewNode) return;
    const relativePath = projectRelativePathFromBrowserUrl(currentUrl, resolvedDir);
    if (!relativePath) {
      setStatusMessage(t('designBrowser.status.onlyProjectHtmlCanSave'));
      return;
    }
    setSavingDomEdit(true);
    try {
      const html = await webviewNode.executeJavaScript<string>(BROWSER_SERIALIZE_HTML_SCRIPT, true);
      const file = await writeProjectTextFile(projectId, relativePath, html, undefined, workspaceContext);
      if (!file) throw new Error(t('designBrowser.status.htmlSaveFailed'));
      await onRefreshFiles();
      setStatusMessage(t('designBrowser.status.htmlSaved'));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t('designBrowser.status.htmlSaveFailed'));
    } finally {
      setSavingDomEdit(false);
    }
  }

  function queueBrowserCommentDraft() {
    const note = commentDraft.trim();
    if (!note) return;
    setQueuedCommentNotes((current) => [...current, note]);
    setCommentDraft('');
  }

  function removeBrowserImage(index: number) {
    setBrowserImages((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setBrowserPreviewIndex((current) => {
      if (current === null) return current;
      if (current === index) return null;
      return current > index ? current - 1 : current;
    });
  }

  async function awaitBrowserCaptureWithDeadline(pending: Promise<File | null> | null): Promise<File | null> {
    if (!pending) return null;
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => {
      diagnoseAnnotationCapture('timeout', 'save-deadline', started); resolve(null);
    }, BROWSER_CAPTURE_DEADLINE_MS); });
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function saveBrowserComment() {
    if (!activeCommentTarget || !onSavePreviewComment) {
      setStatusMessage(t('designBrowser.status.commentSavingUnavailable'));
      return;
    }
    const note = [...queuedCommentNotes, commentDraft.trim()].filter(Boolean).join('\n\n');
    if (!note && browserImages.length === 0 && (activeSavedComment?.attachments?.length ?? 0) === 0) return;
    setSendingComment(true);
    try {
      // The element screenshot is captured asynchronously after the pick. A
      // Save that lands first would persist the row without its image and
      // leave the late file stranded in the popover, so wait for the capture
      // to settle and take its file when nothing has been staged yet. The wait
      // is bounded by the same deadline the pick uses: a capture that never
      // settles must not lock the popover in `sending`, so past it the row is
      // saved without the image.
      const settledCapture = await awaitBrowserCaptureWithDeadline(captureCleanupRef.current);
      const images = browserImages.length > 0
        ? browserImages
        : settledCapture ? [settledCapture] : [];
      // Save only adds the pin to the Comments dock: the user picks pins there
      // and "Send selected" stages them into the composer. Edits pass the
      // existing id so the daemon updates the row instead of creating a pin.
      const saved = await onSavePreviewComment(
        withPreservedPinMetadata(
          browserTargetFromSnapshot(activeCommentTarget, browserControlIdentity),
          activeSavedComment,
        ),
        note,
        false,
        images,
        activeSavedComment?.id,
      );
      if (saved) {
        // Saving finishes the pin: close the popover and re-arm the picker so
        // the next click annotates another element. The saved pin stays
        // editable from its badge or dock row.
        pinOpenOriginRef.current = null;
        void pickBrowserElement('comment');
        // A failed or late capture still saves the note; say so, because the
        // agent will get the pin without a picture of the element. Set after
        // the re-arm so it replaces the picker's "click an element" hint.
        const hasPicture = images.length > 0 || (activeSavedComment?.attachments?.length ?? 0) > 0;
        setStatusMessage(t(hasPicture ? 'designBrowser.status.commentSaved' : 'designBrowser.status.commentSavedNoPicture'));
      }
    } finally {
      setSendingComment(false);
    }
  }

  const browserPopoverBounds = (() => {
    const rect = webviewNode?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
    return { width: rect.width, height: rect.height };
  })();
  const activeBrowserPreviewImage =
    browserPreviewIndex !== null ? browserImagePreviews[browserPreviewIndex] ?? null : null;
  const browserPreviewImageModal = activeBrowserPreviewImage
    ? createPortal(
        <div
          className="staged-preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label={activeBrowserPreviewImage.file.name}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setBrowserPreviewIndex(null);
          }}
        >
          <div className="staged-preview-card">
            <div className="staged-preview-head">
              <span title={activeBrowserPreviewImage.file.name}>{activeBrowserPreviewImage.file.name}</span>
              <button
                type="button"
                className="icon-only od-tooltip"
                onClick={() => setBrowserPreviewIndex(null)}
                aria-label={t('common.close')}
                title={t('common.close')}
                data-tooltip={t('common.close')}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <img src={activeBrowserPreviewImage.url} alt={activeBrowserPreviewImage.file.name} />
          </div>
        </div>,
        document.body,
      )
    : null;
  const commentComposer = activeTool === 'comment' && activeCommentTarget ? (
    <BoardComposerPopover
      target={activeCommentTarget}
      existing={activeSavedComment}
      draft={commentDraft}
      notes={queuedCommentNotes}
      onDraft={setCommentDraft}
      onAddDraft={queueBrowserCommentDraft}
      onRemoveQueuedNote={(index) => setQueuedCommentNotes((current) => current.filter((_, itemIndex) => itemIndex !== index))}
      onClose={closeBrowserCommentPopover}
      onSaveComment={() => saveBrowserComment()}
      // Save adds the pin to the dock; staging into the composer is the dock's
      // "Send selected", so the popover has one primary action.
      onSendBatch={() => saveBrowserComment()}
      allowSendToChat={false}
      compact
      styleEditor={<BrowserInspectPanel embedded mode="edit" target={activeCommentTarget}
        textDraft={textDraft} canSave={false} saving={sendingComment}
        onApplyStyle={(prop, value, allSides) => { void applyBrowserStyle(prop, value, allSides); }}
        onTextDraft={setTextDraft}
        onCommitText={(value) => { void applyBrowserText(value); }}
        onSave={() => {}} onClose={() => {}} />}
      onRemoveMember={() => {}}
      onDeleteComment={onRemovePreviewComment}
      images={browserImagePreviews}
      imageDisclosure={browserImages.some((file) => file.name.startsWith('browser-annotation-'))
        && activeCommentTarget?.maskRects?.some((mask) => mask.textHidden)
        ? t('chat.annotationCaptureDisclosure') : undefined}
      existingImages={(activeSavedComment?.attachments ?? []).map((attachment) => ({
        url: projectRawUrl(projectId, attachment.path, workspaceContext),
        name: attachment.name,
      }))}
      onRemoveImage={removeBrowserImage}
      onPreviewImage={setBrowserPreviewIndex}
      sending={sendingComment || applyingBrowserEdit}
      sendDisabled={!conversationId || !commentDraft.trim() && queuedCommentNotes.length === 0}
      t={t}
      scale={1}
      bounds={browserPopoverBounds}
      commenting
    />
  ) : null;
  // Numbered pins and the side dock show while the comment tool is on, in the
  // live desktop <webview> only: the iframe fallback cannot measure elements
  // and native popups paint above any HTML overlay.
  const pinSurfaceVisible = activeTool === 'comment' && !isBlank && !popup && desktopHostAvailable;
  const pinSideDock = pinSurfaceVisible ? (
    <CommentSideDock
      comments={visibleComments}
      projectId={projectId}
      selectedIds={selectedPinIds}
      activeCommentId={activePreviewCommentId}
      collapsed={pinDockCollapsed}
      onCollapsedChange={setPinDockCollapsed}
      onToggleSelect={(commentId) => {
        setSelectedPinIds((current) => {
          const next = new Set(current);
          if (next.has(commentId)) next.delete(commentId);
          else next.add(commentId);
          return next;
        });
      }}
      onSelectAll={() => setSelectedPinIds(new Set(visibleComments.map((comment) => comment.id)))}
      onClearSelection={() => setSelectedPinIds(new Set())}
      onReply={(comment) => openSavedBrowserComment(comment, 'dock')}
      onSendSelected={() => {
        if (!onStagePreviewComments) return;
        const selected = visibleComments.filter((comment) => selectedPinIds.has(comment.id));
        if (selected.length === 0) return;
        onStagePreviewComments(selected);
        setSelectedPinIds(new Set());
      }}
      sending={false}
      sendDisabled={!onStagePreviewComments}
      renderCreateForm={false}
      t={t}
    />
  ) : null;
  const statusBaseText = typeof statusMessage === 'string' ? statusMessage : statusMessage?.message ?? '';
  const statusText = archiveSaving && statusBaseText
    ? `${statusBaseText} · ${formatBrowserSnapshotElapsed(archiveElapsedSeconds)}`
    : statusBaseText;
  const statusAction = statusMessage && typeof statusMessage === 'object' && statusMessage.actionFileName
    ? statusMessage
    : null;
  const statusIsPageSnapshot = Boolean(
    statusMessage && typeof statusMessage === 'object' && statusMessage.source === 'page-snapshot',
  );
  const showStatusMessage = Boolean(statusMessage) && !(statusIsPageSnapshot && onPageSnapshotToast);

  return (
    <section ref={rootRef} className="design-browser" aria-label={t('designBrowser.aria')}>
      <div className="db-chrome" ref={chromeRef}>
        <div className="db-nav">
          <IconTooltipButton
            label={t('designBrowser.goBack')}
            disabled={!canGoBack}
            onClick={() => navigateHistoryBy(-1)}
          >
            <Icon name="chevron-left" size={16} />
          </IconTooltipButton>
          <IconTooltipButton
            label={t('designBrowser.goForward')}
            disabled={!canGoForward}
            onClick={() => navigateHistoryBy(1)}
          >
            <Icon name="chevron-right" size={16} />
          </IconTooltipButton>
          <IconTooltipButton
            label={isLoading ? t('designBrowser.stopLoading') : t('designBrowser.reload')}
            className={isLoading ? 'is-spinning' : ''}
            disabled={isBlank}
            onClick={() => (isLoading ? stopLoading() : reload(false))}
          >
            <Icon name={isLoading ? 'close' : 'reload'} size={isLoading ? 16 : 15} />
          </IconTooltipButton>
        </div>
        <div className="db-viewport-control">
          <CustomSelect
            className="db-viewport-select"
            triggerClassName="db-viewport-trigger"
            menuClassName="db-viewport-menu"
            ariaLabel={t('designBrowser.viewportAria')}
            title={t(`designBrowser.viewport.${viewport}` as keyof Dict)}
            value={viewport}
            disabled={viewportChanging}
            iconOnly
            onOpenChange={setViewportMenuOpen}
            onChange={(value) => { void selectViewport(value as BrowserViewportId); }}
            options={BROWSER_VIEWPORT_PRESETS.map((preset) => ({
              value: preset.id,
              label: t(`designBrowser.viewport.${preset.id}` as keyof Dict),
              icon: <RemixIcon name={preset.id === 'mobile' ? 'smartphone-line' : preset.id === 'tablet' ? 'tablet-line' : 'computer-line'} size={16} />,
            }))}
          />
          <output aria-live="polite">{viewportSize.width > 0 && viewportSize.height > 0 ? `${viewportSize.width} × ${viewportSize.height}` : '—'}</output>
          {viewportError && <span role="alert">{viewportError}</span>}
        </div>
        <form className="db-address-form" onSubmit={handleAddressSubmit}>
          <BrowserSiteIcon
            className="db-address-site-icon"
            fallback="globe"
            iconUrl={isBlank ? undefined : pageIconUrl}
          />
          <div className="db-address-field">
            <input
              ref={addressInputRef}
              value={shownAddressValue}
              onChange={(event) => {
                setAddressEditing(true);
                setAddressValue(event.target.value);
                setSuggestionsOpen(true);
              }}
              onFocus={(event) => {
                setAddressEditing(true);
                setAddressValue(isBlank ? '' : currentUrl);
                setSuggestionsOpen(true);
                const input = event.currentTarget;
                window.requestAnimationFrame(() => input.select());
              }}
              onBlur={(event) => {
                if (event.currentTarget.form?.contains(event.relatedTarget as Node | null)) return;
                setSuggestionsOpen(false);
                window.setTimeout(() => setAddressEditing(false), 80);
              }}
              placeholder={addressDisplayParts.url ? '' : t('designBrowser.addressPlaceholder')}
              aria-label={t('designBrowser.addressAria')}
              autoComplete="off"
              spellCheck={false}
            />
            {addressDisplayParts.url ? (
              <span className="db-address-display" aria-hidden>
                <span className="db-address-url">{addressDisplayParts.url}</span>
                {addressDisplayParts.title ? (
                  <>
                    <span className="db-address-separator">/</span>
                    <span className="db-address-title">{addressDisplayParts.title}</span>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
          {suggestionsOpen && suggestions.length > 0 ? (
            <div className="db-suggestions" role="listbox">
              {suggestions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  onFocus={() => warmBrowserOrigin(item.url)}
                  onPointerEnter={() => warmBrowserOrigin(item.url)}
                  onClick={() => navigateTo(item.url)}
                >
                  <span className="db-suggestion-icon">
                    <BrowserSiteIcon
                      fallback={item.type === 'history' ? 'history' : 'globe'}
                      iconUrl={item.iconUrl}
                    />
                  </span>
                  <span className="db-suggestion-copy">
                    <span>{item.label}</span>
                    <small>{item.detail}</small>
                  </span>
                  <span className="db-suggestion-type">{item.typeLabel}</span>
                </button>
              ))}
            </div>
          ) : null}
        </form>
        <div className="db-actions">
          {!isBlank ? (
            <IconTooltipButton
              label={t('designBrowser.annotate')}
              wrapperClassName="db-action-item db-action-annotate"
              className={activeTool === 'comment' ? 'is-active' : ''}
              aria-pressed={activeTool === 'comment'}
              onClick={() => {
                setBrowserDiagnosticsOpen(false);
                setMenuOpen(false);
                setBrowserUseOpen(false);
                setSuggestionsOpen(false);
                toggleBrowserTool('comment');
              }}
            >
              <RemixIcon name="message-3-line" size={15} />
            </IconTooltipButton>
          ) : null}
          <IconTooltipButton
            label={t('designBrowser.edge.connect')}
            wrapperClassName="db-action-item db-action-edge"
            className={edgeAnnotationsOpen ? 'is-active' : ''}
            aria-expanded={edgeAnnotationsOpen}
            onClick={() => {
              setEdgeAnnotationsOpen((open) => !open);
              setMenuOpen(false);
              setBrowserUseOpen(false);
              setBrowserDiagnosticsOpen(false);
            }}
          >
            <Icon name="external-link" size={15} />
          </IconTooltipButton>
          {edgeAnnotationsOpen ? (
            <EdgeAnnotationsPanel
              projectId={projectId}
              conversationId={conversationId}
              pageUrl={currentUrl}
              workspaceContext={workspaceContext}
              onOpenExternal={() => void openCurrentExternally()}
            />
          ) : null}
          {browserControlStatus === 'connected' ? (
            <IconTooltipButton
              label={`AI · ${t(browserTabActive ? 'common.active' : 'common.inactive')}`}
              wrapperClassName="db-action-item db-action-ai"
              className={`db-ai-control${browserTabActive ? ' is-active' : ''}`}
              aria-expanded={browserDiagnosticsOpen}
              onClick={() => {
                const opening = !browserDiagnosticsOpen;
                setBrowserDiagnosticsOpen(opening);
                setMenuOpen(false);
                setBrowserUseOpen(false);
                setSuggestionsOpen(false);
                if (opening) void refreshBrowserDiagnostics();
              }}
            >
              <span className="db-ai-control-dot" aria-hidden />
            </IconTooltipButton>
          ) : null}
          {browserDiagnosticsOpen ? (
            <div className="db-browser-diagnostics" role="dialog" aria-label="AI browser diagnostics">
              <div className="db-browser-diagnostics-head">
                <div>
                  <strong>AI</strong>
                  <span>{t('common.active')}</span>
                </div>
                <button
                  type="button"
                  className="db-browser-diagnostics-refresh"
                  aria-label={t('designBrowser.reload')}
                  disabled={browserDiagnosticsLoading}
                  onClick={() => void refreshBrowserDiagnostics()}
                >
                  <Icon name="reload" size={14} />
                </button>
              </div>
              <div className="db-browser-diagnostics-metrics">
                <span><strong>{browserDiagnostics.networkEntries.length}</strong> HTTP</span>
                <span><strong>{browserDiagnostics.consoleEntries.length}</strong> LOG</span>
              </div>
              {browserDiagnosticsError ? (
                <div className="db-browser-diagnostics-error" role="alert">
                  {browserDiagnosticsError}
                </div>
              ) : null}
              <div className="db-browser-diagnostics-list" aria-busy={browserDiagnosticsLoading}>
                {browserDiagnosticsLoading ? (
                  <div className="db-browser-diagnostics-loading">•••</div>
                ) : null}
                {browserDiagnostics.networkEntries.map((entry, index) => (
                  <div
                    className="db-browser-diagnostics-row"
                    key={entry.requestId ?? `${entry.url ?? 'request'}-${index}`}
                    title={entry.url}
                  >
                    <span className="db-browser-diagnostics-method">{entry.method ?? 'GET'}</span>
                    <span className="db-browser-diagnostics-value">
                      {browserDiagnosticUrlLabel(entry.url)}
                    </span>
                    <span className={entry.failed ? 'is-error' : undefined}>
                      {entry.failed ? 'ERR' : entry.responseStatus ?? '…'}
                    </span>
                  </div>
                ))}
                {browserDiagnostics.consoleEntries.map((entry, index) => (
                  <div
                    className="db-browser-diagnostics-row is-console"
                    key={`${entry.level ?? 'log'}-${entry.text ?? ''}-${index}`}
                    title={entry.text}
                  >
                    <span className="db-browser-diagnostics-method">{entry.level ?? 'log'}</span>
                    <span className="db-browser-diagnostics-value">{entry.text ?? ''}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {desktopHostAvailable ? (
            <IconTooltipButton
              label={t('fileViewer.screenshot')}
              wrapperClassName="db-action-item db-action-secondary db-action-screenshot"
              disabled={isBlank || screenshotSaving}
              onClick={takeScreenshot}
            >
              <RemixIcon name="screenshot-2-line" size={15} />
            </IconTooltipButton>
          ) : null}
          <IconTooltipButton
            label={t('browserUse.title')}
            wrapperClassName="db-action-item db-action-browser-use"
            className={browserUseOpen ? 'is-active' : ''}
            onClick={() => {
              setBrowserUseOpen((open) => !open);
              setMenuOpen(false);
              setSuggestionsOpen(false);
            }}
          >
            <Icon name="lightbulb" size={15} />
          </IconTooltipButton>
          {browserUseOpen ? (
            <BrowserUseMenu onPick={requestBrowserUsePrompt} />
          ) : null}
          <IconTooltipButton
            label={t('designBrowser.savePageBrief')}
            wrapperClassName="db-action-item db-action-secondary db-action-save"
            disabled={isBlank || briefSaving}
            onClick={savePageBrief}
          >
            <Icon name="file-code" size={15} />
          </IconTooltipButton>
          <IconTooltipButton
            label={t('designBrowser.menu')}
            wrapperClassName="db-action-item db-action-menu"
            onClick={() => {
              setMenuOpen((open) => !open);
              setBrowserUseOpen(false);
              setSuggestionsOpen(false);
            }}
          >
            <Icon name="more-horizontal" size={16} />
          </IconTooltipButton>
          {menuOpen ? (
            <div className="db-menu" role="menu">
              <button type="button" role="menuitem" onClick={takeScreenshot} disabled={isBlank || screenshotSaving}>
                <Icon name="image" size={14} />
                {t('designBrowser.menu.copyScreenshot')}
              </button>
              <button type="button" role="menuitem" onClick={() => reload(true)} disabled={isBlank}>
                <Icon name="reload" size={14} />
                {t('designBrowser.menu.hardReload')}
              </button>
              <button type="button" role="menuitem" onClick={copyCurrentUrl} disabled={isBlank}>
                <Icon name="copy" size={14} />
                {t('designBrowser.menu.copyUrl')}
              </button>
              <button type="button" role="menuitem" onClick={openCurrentExternally} disabled={isBlank || !isHttpLikeUrl(currentUrl)}>
                <Icon name="external-link" size={14} />
                {t('designBrowser.menu.openInBrowser')}
              </button>
              <span className="db-menu-separator" />
              <button
                type="button"
                role="menuitem"
                className={downloadAttentionNonce != null ? 'is-attention' : undefined}
                onClick={() => void savePageSnapshot({ openAfterSave: false })}
                disabled={isBlank || archiveSaving}
                aria-busy={archiveSaving ? true : undefined}
              >
                <Icon name="download" size={14} />
                {t('designBrowser.downloadPage')}
              </button>
              <button type="button" role="menuitem" onClick={savePageBrief} disabled={isBlank || briefSaving}>
                <Icon name="file" size={14} />
                {t('designBrowser.menu.savePageBrief')}
              </button>
              <button type="button" role="menuitem" onClick={clearHistoryOnly}>
                <Icon name="history" size={14} />
                {t('designBrowser.menu.clearBrowsingHistory')}
              </button>
              <button type="button" role="menuitem" onClick={() => void clearCookies(false)}>
                <Icon name="trash" size={14} />
                {t('designBrowser.menu.clearCookies')}
              </button>
              <button type="button" role="menuitem" onClick={() => void clearCookies(true)}>
                <Icon name="trash" size={14} />
                {t('designBrowser.menu.clearAllData')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {downloadAttentionNonce != null ? (
        <div className="db-download-assist" role="status">
          <span className="db-download-assist-icon" aria-hidden>
            <Icon name="download" size={14} />
          </span>
          <span>{t('designBrowser.status.downloadAssistHint')}</span>
        </div>
      ) : null}
      {showStatusMessage ? (
        <div className="db-status" role="status" style={captureChromeHidden ? { visibility: 'hidden' } : undefined}>
          <span>{statusText}</span>
          {archiveSaving ? (
            <button
              type="button"
              className="db-status-action"
              onClick={cancelPageSnapshot}
            >
              {t('common.cancel')}
            </button>
          ) : statusAction ? (
            <button
              type="button"
              className="db-status-action"
              onClick={() => {
                if (statusAction.actionTarget === 'design-files' && onOpenDesignFiles) {
                  onOpenDesignFiles();
                } else {
                  onOpenFile(statusAction.actionFileName ?? '');
                }
                setStatusMessage(null);
              }}
            >
              {statusAction.actionLabel ?? t('fileViewer.open')}
            </button>
          ) : null}
        </div>
      ) : null}
      {browserPreviewImageModal}
      <div className="db-content">
        <div className="db-content-main">
        <PreviewDrawOverlay
          active={drawOverlayOpen}
          captureTarget={activeCommentTarget
            ? browserTargetFromSnapshot(activeCommentTarget, browserControlIdentity)
            : null}
          captureViewport={!isBlank}
          captureSnapshot={desktopHostAvailable ? captureBrowserSnapshot : undefined}
          captureFrameRect={() => webviewNode?.getBoundingClientRect() ?? null}
          filePath={isBlank ? undefined : currentUrl}
          hideChrome={captureChromeHidden}
          onActiveChange={setDrawOverlayOpen}
          sendDisabled={sendDisabled}
          sendDisabledReason={t('chat.annotationSendDisabledReason')}
        >
          <div ref={viewportFrameRef} className="db-viewport-frame" data-viewport={viewport}
            style={{ width: viewportPreset.width ? `min(${viewportPreset.width}px, 100%)` : '100%',
              height: viewportPreset.height ? `min(${viewportPreset.height}px, 100%)` : '100%', margin: 'auto' }}>
            {popup ? (
              <div ref={setPopupViewport} className="db-webview" data-popup-surface={popup.surfaceId} style={{ position: 'relative', overflow: 'hidden' }}>
                {popupPixels ? <img src={popupPixels} alt="" style={{ width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none' }} /> : null}
              </div>
            ) : isBlank ? (
              <DesignBrowserStart
                onNavigate={navigateTo}
                projectId={projectId}
              />
            ) : desktopHostAvailable ? (
              <webview
                {...DESIGN_BROWSER_POPUP_ATTRIBUTES}
                ref={assignWebviewNode}
                className="db-webview"
                src={loadUrl}
                partition={DESIGN_BROWSER_PARTITION}
                title={pageTitle}
              />
            ) : (
              <div className="db-fallback">
                <iframe
                  title={pageTitle}
                  src={loadUrl}
                  onLoad={(event) => syncFromFallbackFrame(event.currentTarget)}
                />
              </div>
            )}
            <div style={captureChromeHidden ? { visibility: 'hidden' } : undefined}>
              {pinSurfaceVisible ? (
                <BrowserCommentMarkers
                  activeCommentId={activePreviewCommentId}
                  comments={visibleComments}
                  liveTargets={browserLiveCommentTargets}
                  onOpen={(comment) => openSavedBrowserComment(comment, 'badge')}
                />
              ) : null}
              {commentComposer}
            </div>
            {(activeTool === 'inspect' || activeTool === 'edit') && activeCommentTarget ? (
              <BrowserInspectPanel
                mode={activeTool}
                target={activeCommentTarget}
                textDraft={textDraft}
                canSave={editableProjectHtml}
                saving={savingDomEdit}
                onApplyStyle={(prop, value) => { void applyBrowserStyle(prop, value); }}
                onTextDraft={setTextDraft}
                onCommitText={(value) => { void applyBrowserText(value); }}
                onSave={() => { void saveBrowserDomEdit(); }}
                onClose={clearBrowserTool}
              />
            ) : null}
          </div>
          {!isBlank && activeTool && !activeCommentTarget ? (
            <div className="db-tool-hint" role="status">
              {activeTool === 'comment'
                ? t('designBrowser.status.clickElementToComment')
                : t('designBrowser.status.clickElementToTune')}
            </div>
          ) : null}
        </PreviewDrawOverlay>
        </div>
        {pinSideDock}
      </div>
    </section>
  );
}

function IconTooltipButton({
  label,
  className,
  wrapperClassName,
  children,
  ...buttonProps
}: {
  label: string;
  children: ReactNode;
  wrapperClassName?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <span
      className={['db-tooltip-anchor od-tooltip', wrapperClassName].filter(Boolean).join(' ')}
      data-tooltip={label}
      data-tooltip-placement="bottom"
    >
      <button
        {...buttonProps}
        type="button"
        className={['db-icon-btn', className].filter(Boolean).join(' ')}
        aria-label={label}
        title={label}
      >
        {children}
      </button>
    </span>
  );
}

function BrowserUseMenu({
  onPick,
}: {
  onPick: (action: BrowserUseAction) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const categories = useMemo(
    () => filterBrowserUseCategories(
      BROWSER_USE_CATEGORIES,
      query,
      (category) => t(category.titleKey),
      (action) => [t(browserUseActionOutputKey(action)), localizedBrowserUseInput(t, action)],
    ),
    [query, t],
  );
  const visibleTotal = useMemo(
    () => categories.reduce((sum, category) => sum + category.actions.length, 0),
    [categories],
  );

  return (
    <div className="db-menu db-browser-use-menu" role="menu" aria-label={t('browserUse.title')}>
      <div className="db-browser-use-head">
        <strong>{t('browserUse.title')}</strong>
        <small>{t('browserUse.summary', { count: BROWSER_USE_ACTION_TOTAL })}</small>
      </div>
      <label className="db-browser-use-search">
        <Icon name="search" size={13} />
        <input
          type="search"
          value={query}
          aria-label={t('browserUse.searchAria')}
          placeholder={t('browserUse.searchPlaceholder')}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {query ? <span>{visibleTotal}</span> : null}
      </label>
      <div className="db-browser-use-list">
        {categories.map((category) => (
          <section key={category.id} className="db-browser-use-section">
            <div className="db-browser-use-section-title">
              <span>{t(category.titleKey)}</span>
              <span>{category.actions.length}</span>
            </div>
            {category.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                className="db-browser-use-action"
                onClick={() => onPick(action)}
              >
                <Icon name="sparkles" size={13} />
                <span className="db-browser-use-action-copy">
                  <span>{action.label}</span>
                  <small>{t(browserUseActionOutputKey(action))}</small>
                </span>
                <span className="db-browser-use-action-input">{localizedBrowserUseInput(t, action)}</span>
              </button>
            ))}
          </section>
        ))}
        {categories.length === 0 ? (
          <div className="db-browser-use-empty" role="status">{t('browserUse.empty')}</div>
        ) : null}
      </div>
    </div>
  );
}

function BrowserCommentMarkers({
  activeCommentId,
  comments,
  liveTargets,
  onOpen,
}: {
  activeCommentId: string | null;
  comments: PreviewComment[];
  liveTargets: Map<string, BrowserElementSnapshot>;
  onOpen: (comment: PreviewComment) => void;
}) {
  const t = useT();
  if (comments.length === 0) return null;
  return (
    <div className="db-comment-layer" aria-label={t('designBrowser.comments.aria')}>
      {comments.map((comment, index) => {
        // Only a live rect may place a marker. The saved position belongs to
        // the page as it was when the pin was made; on a re-laid-out or
        // navigated page it would point at the wrong pixels, so a pin whose
        // element is missing stays listed in the dock and is not drawn here.
        const snapshot = liveTargets.get(`comment:${comment.id}`);
        if (!snapshot) return null;
        // Clamp to the guest viewport: an element that runs past the edge keeps
        // its number on the visible part instead of at an unclipped corner the
        // frame then hides. Fully off-screen -> no marker.
        const bounds = browserClampedOverlayBounds(snapshot);
        if (!bounds) return null;
        const active = comment.id === activeCommentId;
        const label = comment.label || comment.elementId || t('designBrowser.comments.untitled');
        const number = comment.pinSeq ?? index + 1;
        return (
          <div
            key={comment.id}
            className={`db-comment-marker${active ? ' active' : ''}`}
            data-testid={`db-comment-marker-${comment.id}`}
            data-clamped-right={bounds.clampedRight ? 'true' : undefined}
            data-clamped-top={bounds.clampedTop ? 'true' : undefined}
            style={{
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            }}
          >
            <button
              type="button"
              className="db-comment-marker-badge"
              title={`${number}. ${label}: ${comment.note}`}
              aria-label={t('designBrowser.comments.openPin', { n: number, label })}
              aria-current={active ? 'true' : undefined}
              onClick={() => onOpen(comment)}
            >
              {number}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function browserSnapshotMapsEqual(
  current: Map<string, BrowserElementSnapshot>,
  next: Map<string, BrowserElementSnapshot>,
): boolean {
  if (current.size !== next.size) return false;
  for (const [key, snapshot] of current) {
    const candidate = next.get(key);
    if (!candidate || !browserSnapshotsEqual(snapshot, candidate)) return false;
  }
  return true;
}

function browserSnapshotsEqual(left: BrowserElementSnapshot, right: BrowserElementSnapshot): boolean {
  return (
    left.filePath === right.filePath &&
    left.elementId === right.elementId &&
    left.selector === right.selector &&
    left.label === right.label &&
    left.text === right.text &&
    left.htmlHint === right.htmlHint &&
    left.position.x === right.position.x &&
    left.position.y === right.position.y &&
    left.position.width === right.position.width &&
    left.position.height === right.position.height &&
    JSON.stringify(left.maskRects ?? null) === JSON.stringify(right.maskRects ?? null) &&
    JSON.stringify(left.viewport ?? null) === JSON.stringify(right.viewport ?? null) &&
    JSON.stringify(left.style ?? null) === JSON.stringify(right.style ?? null)
  );
}

function BrowserInspectPanel({
  embedded = false,
  canSave,
  mode,
  onApplyStyle,
  onClose,
  onSave,
  onTextDraft,
  onCommitText,
  saving,
  target,
  textDraft,
}: {
  embedded?: boolean;
  canSave: boolean;
  mode: 'inspect' | 'edit';
  onApplyStyle: (prop: keyof PreviewAnnotationStyle, value: string, allPaddingSides?: boolean) => void;
  onClose: () => void;
  onSave: () => void;
  onTextDraft: (value: string) => void;
  onCommitText: (value: string) => void;
  saving: boolean;
  target: BrowserElementSnapshot;
  textDraft: string;
}) {
  const t = useT();
  const draft = browserStyleDraftFromTarget(target);
  const fontSize = parsePx(draft.fontSize, 16);
  const padding = parsePx(draft.paddingTop, 0);
  const radius = parsePx(draft.borderRadius, 0);

  return (
    <aside className={`inspect-panel db-inspect-panel${embedded ? ' is-embedded' : ''}`} data-testid="browser-inspect-panel">
      {!embedded && <header className="inspect-panel-head">
        <div className="inspect-panel-title">
          <strong title={target.label}>
            {mode === 'edit' ? t('designBrowser.inspect.editTitle') : t('designBrowser.inspect.tuneTitle')}
          </strong>
          <code title={target.selector}>{target.label || target.selector}</code>
        </div>
        <button type="button" className="ghost" onClick={onClose} aria-label={t('designBrowser.inspect.closeTune')}>
          <Icon name="close" size={12} />
        </button>
      </header>}

      <section className="inspect-section">
        <div className="inspect-section-label">{t('designBrowser.inspect.colors')}</div>
        <div className="inspect-row">
          <label htmlFor="db-inspect-color">{t('designBrowser.inspect.text')}</label>
          <input
            id="db-inspect-color"
            type="color"
            value={cssColorToHex(draft.color, '#1f1f1f')}
            onChange={(event) => onApplyStyle('color', event.target.value)}
          />
          <span className="inspect-row-value">{cssColorToHex(draft.color, '#1f1f1f')}</span>
        </div>
        <div className="inspect-row">
          <label htmlFor="db-inspect-bg">{t('designBrowser.inspect.fill')}</label>
          <input
            id="db-inspect-bg"
            type="color"
            value={cssColorToHex(draft.backgroundColor, '#ffffff')}
            onChange={(event) => onApplyStyle('backgroundColor', event.target.value)}
          />
          <span className="inspect-row-value">{cssColorToHex(draft.backgroundColor, '#ffffff')}</span>
        </div>
      </section>

      <section className="inspect-section">
        <div className="inspect-section-label">{t('designBrowser.inspect.type')}</div>
        <div className="inspect-row">
          <label htmlFor="db-inspect-font-size">{t('designBrowser.inspect.size')}</label>
          <input
            id="db-inspect-font-size"
            type="range"
            min={8}
            max={96}
            value={fontSize}
            onChange={(event) => onApplyStyle('fontSize', `${event.target.value}px`)}
          />
          <span className="inspect-row-value">{fontSize}px</span>
        </div>
        <div className="inspect-row">
          <label htmlFor="db-inspect-weight">{t('designBrowser.inspect.weight')}</label>
          <select
            id="db-inspect-weight"
            value={draft.fontWeight}
            onChange={(event) => onApplyStyle('fontWeight', event.target.value)}
          >
            <option value="300">300</option>
            <option value="400">400</option>
            <option value="500">500</option>
            <option value="600">600</option>
            <option value="700">700</option>
            <option value="800">800</option>
          </select>
          <span className="inspect-row-value">{draft.fontWeight}</span>
        </div>
      </section>

      <section className="inspect-section">
        <div className="inspect-section-label">{t('designBrowser.inspect.spacing')}</div>
        <div className="inspect-row">
          <label htmlFor="db-inspect-padding">{t('designBrowser.inspect.pad')}</label>
          <input
            id="db-inspect-padding"
            type="range"
            min={0}
            max={80}
            value={padding}
            onChange={(event) => onApplyStyle('paddingTop', `${event.target.value}px`)}
          />
          <span className="inspect-row-value">{padding}px</span>
        </div>
        <div className="inspect-row">
          <label htmlFor="db-inspect-radius">{t('designBrowser.inspect.radius')}</label>
          <input
            id="db-inspect-radius"
            type="range"
            min={0}
            max={80}
            value={radius}
            onChange={(event) => onApplyStyle('borderRadius', `${event.target.value}px`)}
          />
          <span className="inspect-row-value">{radius}px</span>
        </div>
      </section>

      {mode === 'edit' ? (
        <section className="inspect-section">
          <div className="inspect-section-label">{t('designBrowser.inspect.content')}</div>
          <textarea
            aria-label={t('designBrowser.inspect.elementText')}
            className="db-inspect-text"
            value={textDraft}
            onChange={(event) => onTextDraft(event.target.value)}
            onBlur={(event) => { if (event.target.value !== target.text) onCommitText(event.target.value); }}
          />
        </section>
      ) : null}

      {embedded && <section className="inspect-section">
        <div className="inspect-row">
          <label htmlFor="db-inspect-text-align">{t('manualEdit.align')}</label>
          <select id="db-inspect-text-align" value={target.style?.textAlign === 'center' ? 'center' : ['right', 'end'].includes(target.style?.textAlign ?? '') ? 'right' : 'left'}
            onChange={(event) => onApplyStyle('textAlign', event.target.value)}>
            <option value="left">{t('manualEdit.textAlignLeft')}</option>
            <option value="center">{t('manualEdit.textAlignCenter')}</option>
            <option value="right">{t('manualEdit.textAlignRight')}</option>
          </select>
        </div>
        <div className="inspect-row">
          <label htmlFor="db-inspect-font-family">{t('manualEdit.fontFamily')}</label>
          <input id="db-inspect-font-family" type="text" key={target.style?.fontFamily ?? ''}
            defaultValue={target.style?.fontFamily ?? ''}
            onBlur={(event) => { if (event.target.value !== target.style?.fontFamily) onApplyStyle('fontFamily', event.target.value); }} />
        </div>
        {([
          ['opacity', 'manualEdit.opacity', '', 0, 1],
          ['lineHeight', 'manualEdit.lineHeight', 'px', 0],
          ['borderWidth', 'manualEdit.borderWidth', 'px', 0],
          ['width', 'manualEdit.width', 'px', 1],
          ['height', 'manualEdit.height', 'px', 1],
        ] as const).map(([prop, label, unit, min, max]) => <div className="inspect-row" key={prop}>
          <label htmlFor={`db-inspect-${prop}`}>{t(label)}</label>
          <input id={`db-inspect-${prop}`} type="number" min={min} max={max} step="any"
            key={target.style?.[prop] ?? ''} defaultValue={Number.parseFloat(target.style?.[prop] ?? (prop === 'opacity' ? '1' : '0')) || 0}
            onBlur={(event) => { if (event.target.value && Number.isFinite(Number(event.target.value))) onApplyStyle(prop, `${event.target.value}${unit}`); }} />
        </div>)}
        <div className="inspect-row">
          <label htmlFor="db-inspect-border-color">{t('manualEdit.borderColor')}</label>
          <input id="db-inspect-border-color" type="color" value={cssColorToHex(target.style?.borderColor ?? '', '#1f1f1f')}
            onChange={(event) => onApplyStyle('borderColor', event.target.value)} />
        </div>
        {(['padding', 'margin'] as const).map((group) => <section key={group}>
          <div className="inspect-section-label">{t(group === 'padding' ? 'manualEdit.padding' : 'manualEdit.margin')}</div>
          {(['Top', 'Right', 'Bottom', 'Left'] as const).map((side) => {
            const prop = `${group}${side}` as keyof PreviewAnnotationStyle;
            const sideLabel = { Top: 'manualEdit.sideTop', Right: 'manualEdit.sideRight', Bottom: 'manualEdit.sideBottom', Left: 'manualEdit.sideLeft' } as const;
            return <div className="inspect-row" key={prop}>
              <label htmlFor={`db-inspect-${prop}`}>{t(sideLabel[side])}</label>
              <input id={`db-inspect-${prop}`} type="number" min={group === 'padding' ? 0 : undefined} step="any"
                key={target.style?.[prop] ?? ''} defaultValue={Number.parseFloat(target.style?.[prop] ?? '0') || 0}
                onBlur={(event) => { if (event.target.value && Number.isFinite(Number(event.target.value))) onApplyStyle(prop, `${event.target.value}px`, false); }} />
            </div>;
          })}
        </section>)}
      </section>}

      {!embedded && <footer className="inspect-panel-footer">
        <button type="button" className="ghost" onClick={onClose}>{t('common.close')}</button>
        <button type="button" className="primary" disabled={!canSave || saving} onClick={onSave}>
          {saving
            ? t('designBrowser.inspect.saving')
            : canSave
              ? t('designBrowser.inspect.saveHtml')
              : t('designBrowser.inspect.liveOnly')}
        </button>
      </footer>}
    </aside>
  );
}

const PIN_TARGET_FIELD_SEPARATOR = '\u001f';
const PIN_TARGET_RECORD_SEPARATOR = '\u001e';
/** How long a pick (and a Save landing on it) waits for the element screenshot. */
const BROWSER_CAPTURE_DEADLINE_MS = 1500;

/**
 * Stable string form of the saved pins to re-measure; see the poll effect.
 * A pin with `metadata.scope` lives in a child frame or open shadow root: the
 * top-document `querySelector` the measure script runs cannot resolve it and
 * may hit an unrelated element with the same selector, so it is left out
 * (listed in the dock, never badged) rather than mis-measured.
 */
export function browserPinTargetSignature(comments: readonly PreviewComment[]): string {
  return comments
    .filter((comment) => !comment.metadata?.scope)
    .map((comment) => [comment.id, comment.elementId, comment.selector].join(PIN_TARGET_FIELD_SEPARATOR))
    .join(PIN_TARGET_RECORD_SEPARATOR);
}

export function browserPinTargetsFromSignature(signature: string): BrowserMeasureTargetRequest[] {
  if (!signature) return [];
  return signature.split(PIN_TARGET_RECORD_SEPARATOR).map((record) => {
    const [id = '', elementId = '', selector = ''] = record.split(PIN_TARGET_FIELD_SEPARATOR);
    return { key: `comment:${id}`, elementId, selector, positionOnly: true };
  });
}

function browserSnapshotFromComment(comment: PreviewComment, filePath: string): BrowserElementSnapshot {
  return {
    filePath,
    elementId: comment.elementId,
    selector: comment.selector,
    label: comment.label,
    text: comment.text,
    position: comment.position,
    htmlHint: comment.htmlHint,
    style: comment.style,
    selectionKind: 'element',
  };
}

export function browserTargetFromSnapshot(
  snapshot: BrowserElementSnapshot,
  browserIdentity: Pick<EmbeddedBrowserTarget, 'tabId' | 'webContentsId'> | null = null,
): PreviewCommentTarget {
  return withBrowserControlMetadata({
    filePath: snapshot.filePath,
    elementId: snapshot.elementId,
    selector: snapshot.selector,
    label: snapshot.label,
    text: snapshot.text.trim().slice(0, 500),
    position: snapshot.position,
    htmlHint: snapshot.htmlHint.trim().slice(0, 500),
    style: snapshot.style,
    selectionKind: 'element',
  }, browserIdentity);
}

/**
 * An in-app edit re-derives the target from the live element, and the daemon
 * upsert replaces `metadata` wholesale. The row's `scope` (child frame / open
 * shadow root) and `source` (which surface placed the pin) are facts about the
 * pin, not about this edit, so they ride along unchanged.
 */
export function withPreservedPinMetadata(
  target: PreviewCommentTarget,
  existing: Pick<PreviewComment, 'metadata'> | null,
): PreviewCommentTarget {
  const scope = existing?.metadata?.scope;
  const source = existing?.metadata?.source;
  if (!scope && !source) return target;
  return {
    ...target,
    metadata: {
      ...target.metadata,
      ...(source ? { source } : {}),
      ...(scope ? { scope } : {}),
    },
  };
}

/** Marker box intersected with the guest viewport (when the measurement
 *  carries one). `null` when nothing of the element is on screen. */
export function browserClampedOverlayBounds(snapshot: BrowserElementSnapshot): {
  left: number; top: number; width: number; height: number; clampedRight: boolean; clampedTop: boolean;
} | null {
  const raw = browserOverlayBounds(snapshot);
  const viewport = snapshot.viewport;
  if (!viewport || !(viewport.width > 0) || !(viewport.height > 0)) {
    return { ...raw, clampedRight: false, clampedTop: false };
  }
  const left = Math.max(0, raw.left);
  const top = Math.max(0, raw.top);
  const right = Math.min(viewport.width, raw.left + raw.width);
  const bottom = Math.min(viewport.height, raw.top + raw.height);
  if (right <= left || bottom <= top) return null;
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    clampedRight: right < raw.left + raw.width,
    clampedTop: top > raw.top,
  };
}

function browserOverlayBounds(snapshot: BrowserElementSnapshot) {
  const position = snapshot.position;
  return {
    left: Math.round(position.x),
    top: Math.round(position.y),
    width: Math.max(1, Math.round(position.width)),
    height: Math.max(1, Math.round(position.height)),
  };
}

function browserStyleDraftFromTarget(target: BrowserElementSnapshot): BrowserStyleDraft {
  const style = target.style ?? {};
  return {
    backgroundColor: style.backgroundColor || '#ffffff',
    borderRadius: style.borderRadius || '0px',
    color: style.color || '#1f1f1f',
    fontSize: style.fontSize || '16px',
    fontWeight: style.fontWeight || '400',
    lineHeight: style.lineHeight || 'normal',
    paddingTop: style.paddingTop || style.paddingRight || style.paddingBottom || style.paddingLeft || '0px',
    textAlign: style.textAlign || 'start',
  };
}

function parsePx(value: string, fallback: number): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(value.trim());
  if (!match) return fallback;
  const next = Math.round(Number(match[1]));
  return Number.isFinite(next) ? next : fallback;
}

function cssColorToHex(value: string, fallback: string): string {
  const raw = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw.slice(1).split('').map((char) => char + char).join('')}`;
  }
  const match = raw.match(/rgba?\(\s*([0-9.]+)[ ,]+([0-9.]+)[ ,]+([0-9.]+)/i);
  if (!match) return fallback;
  const toHex = (part: string | undefined) => {
    const number = Math.max(0, Math.min(255, Math.round(Number(part ?? 0))));
    return number.toString(16).padStart(2, '0');
  };
  return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
}

const REFERENCE_ALL_CATEGORY = 'all';

function DesignBrowserStart({
  onNavigate,
  projectId,
}: {
  onNavigate: (url: string) => void;
  projectId?: string;
}) {
  const t = useT();
  const analytics = useAnalytics();
  const [activeCategory, setActiveCategory] = useState<string>(REFERENCE_ALL_CATEGORY);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    trackReferenceBoardSurfaceView(analytics.track, {
      page_name: 'file_manager',
      area: 'reference_board',
      ...(projectId ? { project_id: projectId } : {}),
    });
  }, [analytics.track, projectId]);

  const visibleGroups = useMemo(
    () => filterReferenceGroups(REFERENCE_GROUPS, activeCategory, query, t),
    [activeCategory, query, t],
  );
  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;

  const resetFilters = () => {
    setQuery('');
    setActiveCategory(REFERENCE_ALL_CATEGORY);
    searchRef.current?.focus();
  };

  const selectCategory = (categoryId: string) => {
    setActiveCategory(categoryId);
    trackReferenceBoardClick(analytics.track, {
      page_name: 'file_manager',
      area: 'reference_board',
      element: 'category_chip',
      category_id: categoryId as TrackingReferenceBoardCategory,
      ...(projectId ? { project_id: projectId } : {}),
    });
  };

  const openSite = (site: ReferenceSite) => {
    trackReferenceBoardClick(analytics.track, {
      page_name: 'file_manager',
      area: 'reference_board',
      element: 'open_site',
      site_id: referenceSiteId(site.url),
      ...(projectId ? { project_id: projectId } : {}),
    });
    onNavigate(site.url);
  };

  return (
    <div className="db-start">
      <div className="db-start-hero">
        <div className="db-start-hero-copy">
          <div className="db-kicker">{t('designBrowser.reference.kicker')}</div>
          <h2>{t('designBrowser.reference.title')}</h2>
          <p className="db-start-sub">
            {t('designBrowser.reference.subtitle')}
          </p>
        </div>
      </div>

      <div className="db-reference-toolbar">
        <div
          className="db-reference-chips"
          role="tablist"
          aria-label={t('designBrowser.reference.categoryAria')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeCategory === REFERENCE_ALL_CATEGORY}
            className={`db-reference-chip${activeCategory === REFERENCE_ALL_CATEGORY ? ' is-active' : ''}`}
            onClick={() => selectCategory(REFERENCE_ALL_CATEGORY)}
          >
            {t('common.all')}
            <span className="db-reference-chip-count">{REFERENCE_TOTAL}</span>
          </button>
          {REFERENCE_GROUPS.map((group) => (
            <button
              key={group.id}
              type="button"
              role="tab"
              aria-selected={activeCategory === group.id}
              className={`db-reference-chip${activeCategory === group.id ? ' is-active' : ''}`}
              onClick={() => selectCategory(group.id)}
            >
              {localizedReferenceGroupTitle(group, t)}
              <span className="db-reference-chip-count">{group.sites.length}</span>
            </button>
          ))}
        </div>
        <div className="db-reference-search">
          <span className="db-reference-search-icon" aria-hidden>
            <Icon name="search" size={13} />
          </span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => {
              // Tracked on focus rather than every keystroke so each
              // engagement counts once.
              trackReferenceBoardClick(analytics.track, {
                page_name: 'file_manager',
                area: 'reference_board',
                element: 'search_input',
                ...(projectId ? { project_id: projectId } : {}),
              });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery('');
              }
            }}
            placeholder={t('designBrowser.reference.searchPlaceholder')}
            aria-label={t('designBrowser.reference.searchAria')}
          />
          {hasQuery ? (
            <button
              type="button"
              className="db-reference-search-clear"
              aria-label={t('designBrowser.reference.clearSearch')}
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
      </div>

      {visibleGroups.length === 0 ? (
        <div className="db-reference-empty" role="status">
          <p className="db-reference-empty-title">
            {t('designBrowser.reference.noMatches', { query: trimmedQuery })}
          </p>
          <button
            type="button"
            className="db-reference-empty-action"
            onClick={resetFilters}
          >
            {t('designBrowser.reference.clearFilters')}
          </button>
        </div>
      ) : (
        <div className="db-reference-board">
          {visibleGroups.map((group) => (
            <section key={group.id} className="db-reference-group">
              <h3>
                {localizedReferenceGroupTitle(group, t)}
                <span className="db-reference-group-count">{group.sites.length}</span>
              </h3>
              <div className="db-reference-list">
                {group.sites.map((site) => (
                  <article
                    key={site.url}
                    className="db-reference-card"
                    onPointerEnter={() => warmBrowserOrigin(site.url)}
                  >
                    <button type="button" onClick={() => openSite(site)}>
                      <BrowserSiteIcon
                        className="db-reference-icon"
                        fallback="globe"
                        iconUrl={referenceIconUrl(site.url)}
                      />
                      <span className="db-reference-title">
                        <span>{site.label}</span>
                        <small>{hostnameFromUrl(site.url)}</small>
                      </span>
                    </button>
                    <p>{localizedReferenceSiteDetail(site, t)}</p>
                    <div className="db-reference-actions">
                      <button type="button" onClick={() => openSite(site)}>
                        <Icon name="globe" size={13} />
                        {t('designBrowser.reference.open')}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function BrowserSiteIcon({
  className,
  fallback,
  iconUrl,
}: {
  className?: string;
  fallback: 'globe' | 'history';
  iconUrl?: string;
}) {
  const [failed, setFailed] = useState(false);
  const cleanUrl = cleanIconUrl(iconUrl);
  return (
    <span className={['db-site-icon', className].filter(Boolean).join(' ')}>
      {cleanUrl && !failed ? (
        <img alt="" src={cleanUrl} onError={() => setFailed(true)} />
      ) : (
        <Icon name={fallback} size={13} />
      )}
    </span>
  );
}

export function normalizeBrowserAddress(rawAddress: string): string {
  const value = rawAddress.trim();
  if (!value) return EMPTY_URL;
  if (value === EMPTY_URL) return EMPTY_URL;
  if (/^(https?|file):\/\//i.test(value)) return value;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
  if (/^(127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
  if (value.startsWith('/')) {
    if (/^\/(api|artifacts|frames)(\/|$)/.test(value) && typeof window !== 'undefined') {
      return new URL(value, window.location.origin).toString();
    }
    return `file://${encodeURI(value)}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export function labelFromUrl(url: string): string {
  if (url === EMPTY_URL) return 'New Tab';
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

export interface AddressDisplayParts {
  url: string;
  title?: string;
}

export function formatAddressDisplayParts(url: string, title?: string): AddressDisplayParts {
  if (url === EMPTY_URL) return { url: '' };
  const cleanTitle = title?.trim();
  if (!cleanTitle) return { url };
  const fallback = labelFromUrl(url);
  if (cleanTitle === fallback || cleanTitle === url) return { url };
  return { url: url.replace(/\/+$/, ''), title: cleanTitle };
}

export function formatAddressDisplay(url: string, title?: string): string {
  const parts = formatAddressDisplayParts(url, title);
  if (!parts.url) return '';
  if (!parts.title) return parts.url;
  return `${parts.url} / ${parts.title}`;
}

export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Slugs a reference site URL into the snake_case `site_id` reported by
// reference-board analytics: hostname minus the TLD, non-alphanumerics
// folded into underscores (`land-book.com` → `land_book`,
// `fonts.google.com` → `fonts_google`).
function referenceSiteId(url: string): string {
  const labels = hostnameFromUrl(url).toLowerCase().split('.');
  const slug = (labels.length > 1 ? labels.slice(0, -1) : labels)
    .join('_')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'unknown';
}

export function faviconUrl(url: string): string | undefined {
  if (!isHttpLikeUrl(url)) return undefined;
  try {
    return new URL('/favicon.ico', new URL(url).origin).toString();
  } catch {
    return undefined;
  }
}

/**
 * Resolve a reliable, colored favicon for a curated reference site.
 *
 * The Reference Board lists well-known public design sites, and many of them do
 * not serve a usable icon at `/favicon.ico` (wrong path, 404, or non-image), so
 * {@link faviconUrl} falls back to a flat grey globe for most of them. Routing
 * the request through a favicon service returns a real, correctly-sized brand
 * icon for essentially every domain, so the board shows actual logos instead.
 * Returns `undefined` for non-http(s) URLs so the globe fallback still applies.
 */
export function referenceIconUrl(url: string, size = 64): string | undefined {
  if (!isHttpLikeUrl(url)) return undefined;
  try {
    const host = new URL(url).hostname;
    if (!host) return undefined;
    return `https://www.google.com/s2/favicons?sz=${size}&domain=${encodeURIComponent(host)}`;
  } catch {
    return undefined;
  }
}

export function isHistoryUrl(url: string): boolean {
  return url !== EMPTY_URL && (isHttpLikeUrl(url) || /^file:\/\//i.test(url));
}

function isHttpLikeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function sameUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
}

function safeGetWebviewUrl(node: WebviewElement): string {
  try {
    return node.getURL();
  } catch {
    return '';
  }
}

function safeGetWebviewTitle(node: WebviewElement): string {
  try {
    return node.getTitle();
  } catch {
    return '';
  }
}

function safeGetWebContentsId(node: WebviewElement): number | null {
  try {
    const id = node.getWebContentsId();
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function cleanIconUrl(url?: string): string | undefined {
  const value = url?.trim();
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;
  return undefined;
}

function warmBrowserOrigin(url: string): void {
  if (typeof document === 'undefined' || !isHttpLikeUrl(url)) return;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  if (warmedOrigins.has(origin)) return;
  const links: HTMLLinkElement[] = [];
  for (const rel of ['dns-prefetch', 'preconnect']) {
    const link = document.createElement('link');
    link.rel = rel;
    link.href = origin;
    if (rel === 'preconnect') link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
    links.push(link);
  }
  warmedOrigins.set(origin, links);
  // FIFO-evict the oldest warmed origin once over the cap, removing its links.
  while (warmedOrigins.size > WARMED_ORIGIN_LIMIT) {
    const oldest = warmedOrigins.keys().next().value as string | undefined;
    if (oldest == null) break;
    warmedOrigins.get(oldest)?.forEach((link) => link.remove());
    warmedOrigins.delete(oldest);
  }
}

function canUseNativeHistoryNavigation(node: WebviewElement, delta: -1 | 1): boolean {
  try {
    if (delta < 0) return typeof node.canGoBack === 'function' && node.canGoBack();
    return typeof node.canGoForward === 'function' && node.canGoForward();
  } catch {
    return false;
  }
}

function imageSizeFromDataUrl(dataUrl: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({
      w: Math.max(1, img.naturalWidth || img.width),
      h: Math.max(1, img.naturalHeight || img.height),
    });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function cropDataUrl(
  dataUrl: string,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  maxEdge = Infinity,
): Promise<{ dataUrl: string; w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const naturalW = Math.max(1, img.naturalWidth || img.width);
        const naturalH = Math.max(1, img.naturalHeight || img.height);
        const cx = Math.max(0, Math.min(Math.round(sx), naturalW - 1));
        const cy = Math.max(0, Math.min(Math.round(sy), naturalH - 1));
        const cw = Math.max(1, Math.min(Math.round(sw), naturalW - cx));
        const ch = Math.max(1, Math.min(Math.round(sh), naturalH - cy));
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, maxEdge / Math.max(cw, ch));
        canvas.width = Math.max(1, Math.round(cw * scale));
        canvas.height = Math.max(1, Math.round(ch * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height);
        resolve({ dataUrl: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** Rings the clicked element in a pin picture that shows page around it. */
function outlinePinCapture(
  snapshot: { dataUrl: string; w: number; h: number },
  ring: { x: number; y: number; width: number; height: number },
  pixelsPerCss: number,
): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = snapshot.w;
        canvas.height = snapshot.h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(snapshot); return; }
        ctx.drawImage(img, 0, 0, snapshot.w, snapshot.h);
        // Drawn just outside the element so the ring never covers its pixels;
        // a light halo keeps it visible on dark and on accent-coloured pages.
        const line = Math.max(2, Math.round(2 * pixelsPerCss));
        const outset = line * 1.5;
        const box = [ring.x - outset, ring.y - outset, ring.width + 2 * outset, ring.height + 2 * outset] as const;
        ctx.lineWidth = line * 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.strokeRect(...box);
        ctx.lineWidth = line;
        ctx.strokeStyle = '#ff5a3c';
        ctx.strokeRect(...box);
        resolve({ dataUrl: canvas.toDataURL('image/png'), w: snapshot.w, h: snapshot.h });
      } catch { resolve(snapshot); }
    };
    img.onerror = () => resolve(snapshot);
    img.src = snapshot.dataUrl;
  });
}

/** Trims plain empty margins from a mostly-empty pin picture (see pinCaptureTrim). */
function trimPinCapture(
  snapshot: { dataUrl: string; w: number; h: number },
  pixelsPerCss: number,
): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = snapshot.w;
        canvas.height = snapshot.h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) { resolve(snapshot); return; }
        ctx.drawImage(img, 0, 0, snapshot.w, snapshot.h);
        const keep = pinCaptureTrim(ctx.getImageData(0, 0, snapshot.w, snapshot.h), pixelsPerCss);
        if (!keep) { resolve(snapshot); return; }
        void cropDataUrl(snapshot.dataUrl, keep.x, keep.y, keep.width, keep.height)
          .then((trimmed) => resolve(trimmed ?? snapshot), () => resolve(snapshot));
      } catch { resolve(snapshot); }
    };
    img.onerror = () => resolve(snapshot);
    img.src = snapshot.dataUrl;
  });
}

function maskBrowserAnnotationSnapshot(
  snapshot: { dataUrl: string; w: number; h: number },
  masks: NonNullable<BrowserElementSnapshot['maskRects']>,
): Promise<{ dataUrl: string; w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = snapshot.w;
        canvas.height = snapshot.h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, snapshot.w, snapshot.h);
        ctx.fillStyle = '#7f7f7f';
        for (const mask of masks) {
          if (mask.textHidden === true) continue;
          if (mask.x < 0 || mask.y < 0 || mask.x + mask.width > snapshot.w
            || mask.y + mask.height > snapshot.h) { resolve(null); return; }
          ctx.fillRect(Math.floor(mask.x), Math.floor(mask.y),
            Math.ceil(mask.x + mask.width) - Math.floor(mask.x),
            Math.ceil(mask.y + mask.height) - Math.floor(mask.y));
        }
        resolve({ dataUrl: canvas.toDataURL('image/png'), w: snapshot.w, h: snapshot.h });
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = snapshot.dataUrl;
  });
}

function animateImageIntoChat(
  dataUrl: string,
  source: { left: number; top: number; width: number; height: number },
): void {
  // The chat slot is hidden with the `split-chat-slot-hidden` class, not the
  // `hidden` attribute this used to test for — so `:not([hidden])` matched
  // every slot and could land the animation on the hidden composer.
  const target = document.querySelector<HTMLElement>(
    '.split-chat-slot:not(.split-chat-slot-hidden) [data-testid="chat-composer"] .composer-input-wrap',
  ) ?? document.querySelector<HTMLElement>('[data-testid="chat-composer"]');
  if (!target) return;
  const destination = target.getBoundingClientRect();
  const image = document.createElement('img');
  image.src = dataUrl;
  image.alt = '';
  Object.assign(image.style, {
    position: 'fixed',
    zIndex: '2147483647',
    left: `${source.left}px`,
    top: `${source.top}px`,
    width: `${source.width}px`,
    height: `${source.height}px`,
    borderRadius: '8px',
    boxShadow: '0 18px 46px rgba(0,0,0,.28)',
    objectFit: 'cover',
    pointerEvents: 'none',
    transformOrigin: 'center center',
  });
  document.body.appendChild(image);

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !image.animate) {
    image.remove();
    return;
  }
  const sourceCenterX = source.left + source.width / 2;
  const sourceCenterY = source.top + source.height / 2;
  const targetCenterX = destination.left + destination.width / 2;
  const targetCenterY = destination.top + destination.height / 2;
  const translateX = targetCenterX - sourceCenterX;
  const translateY = targetCenterY - sourceCenterY;
  const scale = Math.max(
    0.06,
    Math.min(0.22, 32 / Math.max(source.width, source.height)),
  );
  const animation = image.animate(
    [
      { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
      {
        offset: 0.72,
        opacity: 0.92,
        transform: `translate3d(${translateX * 0.78}px, ${translateY * 0.78 - 18}px, 0) scale(${Math.max(scale * 1.45, 0.12)})`,
      },
      {
        opacity: 0.12,
        transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`,
      },
    ],
    { duration: 640, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
  );
  animation.addEventListener('finish', () => image.remove(), { once: true });
  animation.addEventListener('cancel', () => image.remove(), { once: true });
}

export function browserFileName(prefix: string, url: string, extension: 'md' | 'png'): string {
  const host = labelFromUrl(url).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'page';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `browser/${prefix}-${host}-${stamp}.${extension}`;
}

function pageSnapshotAbortError(): Error {
  const error = new Error('Page snapshot canceled.');
  error.name = 'AbortError';
  return error;
}

function isPageSnapshotAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfPageSnapshotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw pageSnapshotAbortError();
}

function abortablePageSnapshotPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(pageSnapshotAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(pageSnapshotAbortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function pageSnapshotRunElapsedSeconds(run: { startedAt: number }): number {
  return Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
}

function formatBrowserSnapshotElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}

function browserPageArchiveDir(url: string, date = new Date()): string {
  const host = labelFromUrl(url).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'page';
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `browser/snapshots/${host}-${stamp}`;
}

function isBrowserPageArchiveCapture(value: unknown): value is BrowserPageArchiveCapture {
  if (!value || typeof value !== 'object') return false;
  const capture = value as Partial<BrowserPageArchiveCapture>;
  return (
    typeof capture.url === 'string' &&
    typeof capture.html === 'string' &&
    typeof capture.css === 'string' &&
    Array.isArray(capture.resources)
  );
}

export function pageBriefMarkdown(brief: PageBrief, fallbackUrl: string): string {
  const title = brief.title || labelFromUrl(fallbackUrl);
  const url = brief.url || fallbackUrl;
  const lines = [
    `# ${title}`,
    '',
    `Source: ${url}`,
    '',
  ];
  if (brief.description) {
    lines.push('## Description', '', brief.description, '');
  }
  appendList(lines, 'Headings', brief.headings);
  appendList(lines, 'Images', brief.images);
  appendList(lines, 'Links', brief.links?.map((link) => `${link.text} - ${link.url}`));
  appendList(lines, 'Colors', brief.colors?.map((color) => `${color.value} (${color.count})`));
  return `${lines.join('\n').trim()}\n`;
}

function appendList(lines: string[], title: string, values?: string[]) {
  const filtered = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (filtered.length === 0) return;
  lines.push(`## ${title}`, '');
  for (const value of filtered) lines.push(`- ${value}`);
  lines.push('');
}

// Writes a captured page image onto the system clipboard via the async
// Clipboard API. Decodes the data URL locally (no fetch) so it works under a
// strict connect-src CSP, and returns false instead of throwing when the
// browser lacks ClipboardItem or the write is blocked, so the caller can still
// fall back to the saved-to-project confirmation.
async function copyImageToClipboard(dataUrl: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    const [header = '', base64 = ''] = dataUrl.split(',', 2);
    const mime = /^data:([^;,]+)/.exec(header)?.[1] || 'image/png';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const blob = new Blob([bytes], { type: mime });
    await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
    return true;
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall back for desktop/web contexts where clipboard permission is blocked.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}
