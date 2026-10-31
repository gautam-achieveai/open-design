import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { Icon } from './Icon';
import { RailRecentRow } from './entry-nav-rail/RailRecentRow';
import { ProjectDeleteConfirmDialog } from './project-actions/ProjectDeleteConfirmDialog';
import { projectOwnedBySelf } from './project-actions/ownership';
import { useProjectDeleteFlow } from './project-actions/useProjectDeleteFlow';
import { useProjectDuplicateFlow } from './project-actions/useProjectDuplicateFlow';
import type { SharedProjectPredicate } from '../collab/all-projects-list';
import { acknowledgeProjectCompletion, useProjectRunStatuses } from '../hooks/useProjectRunStatuses';
import type { EntrySettingsSection } from './EntrySettingsMenu';
import type { Project } from '../types';
import { isRtlLocale, useI18n } from '../i18n';
import { workspaceIdentityCacheKey } from '../collab/useWorkspaceContext';
import type { EntryHomeView } from '../router';
import type { AccountMenuClickProps, TrackingProjectCollectionPage, TrackingWorkspacePage } from '@open-design/contracts/analytics';
import { useAnalytics } from '../analytics/provider';
import { trackAccountMenuClick, trackEntryNavigationClick } from '../analytics/events';
import { entryViewToTracking, workspaceAnalyticsDimensions } from '../analytics/workspace';
import { workspaceChromeAccountActionsHost } from './workspaceChromeActions';

const DISCORD_URL = 'https://discord.gg/mHAjSMV6gz';
const X_URL = 'https://x.com/OpenDesignHQ';
const CONTACT_EMAIL_URL = 'mailto:support@open-design.ai';
const externalLinkProps = { target: '_blank', rel: 'noreferrer noopener' } as const;

export type EntryView = EntryHomeView;

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  onOpenSearch?: () => void;
  newProjectDisabled?: boolean;
  /** When false the rail is hidden and its controls are inert. */
  open: boolean;
  context: WorkspaceCollabContext | null;
  onOpenSettings?: (section?: EntrySettingsSection) => void;
  updaterSlot?: ReactNode;
  /** The same catalog and order used by the project grid. */
  recentProjects?: Project[];
  onRenameRecentProject?: (id: string, name: string) => void;
  onDeleteRecentProject?: (id: string) => Promise<boolean | void> | boolean | void;
  onDuplicateRecentProject?: (id: string) => Promise<void> | void;
  isSharedRecentProject?: SharedProjectPredicate;
  recentProjectOwnerMemberIds?: ReadonlyMap<string, string>;
  onOpenRecentProject?: (id: string) => void | Promise<unknown>;
}

interface NavButtonProps {
  active?: boolean;
  ariaLabel: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  /** Rail items that own a popup surface expose the button so the surface can
   *  return focus here on close, and advertise the popup's kind + open state. */
  buttonRef?: Ref<HTMLButtonElement>;
  ariaHasPopup?: 'dialog' | 'menu';
  ariaExpanded?: boolean;
  children: ReactNode;
}

// No `data-tooltip` here: every nav item renders its label inline, so the
// rail's hover bubble (entry-layout.css) would only duplicate visible text.
// That bubble stays reserved for the rail's icon-only controls (updater,
// avatar, icon-only sign-out).
function NavButton({
  active,
  ariaLabel,
  label,
  onClick,
  disabled,
  testId,
  buttonRef,
  ariaHasPopup,
  ariaExpanded,
  children,
}: NavButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaHasPopup ? Boolean(ariaExpanded) : undefined}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <span className="entry-nav-rail__btn-icon" aria-hidden>{children}</span>
      <span className="entry-nav-rail__btn-label">{label}</span>
    </button>
  );
}

/** Remembers the section's open/closed state across launches, next to the
 *  rail's own `od.entry.railOpen`. A disclosure the user closed should stay
 *  closed — re-opening it on every boot is the whole reason to have the
 *  control. */
const RECENT_SECTION_STORAGE_KEY = 'od.entry.railRecentOpen';

/**
 * How many rows the 最近项目 list shows before it scrolls — 11 × 38px rows on a
 * desktop window (see `.entry-nav-rail__recent-list`). The head of the list
 * whose status is asked for before the scroll observer has reported.
 */
const RECENT_STATUS_HEAD_ROWS = 11;

function readStoredRecentOpen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    // Default OPEN: the section is new and a collapsed-by-default disclosure
    // reads as a missing feature.
    return window.localStorage.getItem(RECENT_SECTION_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function RailRecentSection({
  projects,
  onOpen,
  onRename,
  onDelete,
  onDuplicate,
  isShared,
  ownerMemberIds,
  workspaceContext,
  analyticsPage,
  label,
}: {
  projects: Project[];
  onOpen?: (id: string) => void | Promise<unknown>;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => Promise<boolean | void> | boolean | void;
  onDuplicate?: (id: string) => Promise<void> | void;
  isShared?: SharedProjectPredicate;
  ownerMemberIds?: ReadonlyMap<string, string>;
  workspaceContext?: WorkspaceCollabContext | null;
  analyticsPage: TrackingWorkspacePage;
  label: string;
}) {
  const [open, setOpen] = useState(readStoredRecentOpen);
  // The row actions report under the project-collection page the rail is
  // standing on; every other entry view files under Home, where the rail's
  // list is the recent-projects surface.
  const collectionPage: TrackingProjectCollectionPage =
    analyticsPage === 'drafts' || analyticsPage === 'all_projects' ? analyticsPage : 'home';
  const isSharedProject: SharedProjectPredicate = isShared ?? (() => false);
  const ownedBySelf = (projectId: string) => projectOwnedBySelf({
    projectId,
    ownerMemberIds,
    selfMemberId: workspaceContext?.workspaceMemberId,
    isShared: isSharedProject,
  });
  // 删除 confirms through the shared project delete dialog (OPEND-2797) — one
  // component for the rail and the project cards.
  const deleteFlow = useProjectDeleteFlow({
    onDelete,
    analyticsPage: collectionPage,
    workspaceContext,
  });
  const duplicateFlow = useProjectDuplicateFlow({
    onDuplicate,
    analyticsPage: collectionPage,
    workspaceContext,
  });
  // Every recent project, newest first (OPEND-2757: the old 8-row cap hid the
  // rest from the rail entirely). The LIST scrolls past ~11 rows, not the rail
  // — see `.entry-nav-rail__recent-list` in entry-layout.css.
  const items = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt - a.updatedAt),
    [projects],
  );
  // Run status for the rows' leading glyph. `Project.status` cannot serve it —
  // it only arrives on the UNSCOPED project list, so it is absent for every
  // workspace-bound project (see the hook's own note) — and this is the same
  // feed, with the same display mapping (✓-spending included), that the
  // workspace tab dropdown reads, which is what keeps the two glyph columns
  // telling one story about a project (OPEND-2795).
  const recentListRef = useRef<HTMLUListElement>(null);
  // Keep the full catalog navigable, but poll only rows intersecting its
  // scrollport. The list's existing height cap bounds the status request set.
  // Visibility belongs to a particular identity and catalog. An empty catalog
  // removes the list DOM without unmounting this component, so an observer
  // callback cannot be relied on to retire the previous catalog's IDs.
  const visibilityScope = JSON.stringify([
    workspaceIdentityCacheKey(workspaceContext ?? null),
    items.map((project) => project.id).sort(),
  ]);
  const [visibleProjects, setVisibleProjects] = useState<{
    scope: string;
    ids: string[];
  } | null>(null);
  useEffect(() => {
    const list = recentListRef.current;
    if (!open || !list || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      if (!active) return;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.projectId;
        if (!id) continue;
        if (entry.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      const next = [...visible].sort();
      setVisibleProjects((prev) =>
        prev?.scope === visibilityScope
          && prev.ids.length === next.length
          && prev.ids.every((id, index) => id === next[index])
          ? prev
          : { scope: visibilityScope, ids: next });
    }, { root: list });
    for (const row of list.children) observer.observe(row);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [items, open, visibilityScope]);
  // Until the observer has spoken, ask for the head of the list — the rows the
  // cap shows on a desktop window — in the same commit that paints them
  // (OPEND-2762). The observer's first report lands a frame later, and waiting
  // for it is what left the rows a round trip ahead of their glyphs.
  const runStatusProjectIds = useMemo(
    () => visibleProjects?.scope === visibilityScope
      ? visibleProjects.ids
      : items.slice(0, RECENT_STATUS_HEAD_ROWS).map((project) => project.id),
    [visibleProjects, visibilityScope, items],
  );
  const runStatusByProjectId = useProjectRunStatuses(runStatusProjectIds, {
    enabled: open,
    workspaceContext,
  });

  // Opening a project is what spends its ✓ (per product): the finished run on
  // screen is recorded as seen — in the shared feed, so the tab switcher drops
  // the mark in the same moment.
  const openProject = useCallback(
    (id: string) => {
      acknowledgeProjectCompletion(id);
      return onOpen?.(id);
    },
    [onOpen],
  );

  function toggle() {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      try {
        window.localStorage.setItem(RECENT_SECTION_STORAGE_KEY, String(next));
      } catch {
        // Private mode / storage disabled: the section still toggles, it just
        // forgets. Never let a storage failure swallow the interaction.
      }
      return next;
    });
  }

  // Nothing to list is not an empty state worth a row: a workspace with no
  // projects yet should see the rail it had before this section existed.
  if (items.length === 0) return null;

  return (
    <div className="entry-nav-rail__recent">
      <button
        type="button"
        className="entry-nav-rail__recent-head"
        onClick={toggle}
        aria-expanded={open}
        data-testid="entry-nav-recent-toggle"
      >
        {/* Title first, chevron trailing (per product: 展开和收起的按钮在最右侧).
            DOM order follows the visual one rather than an `order` swap, so the
            reading order matches too. */}
        <span className="entry-nav-rail__recent-title">{label}</span>
        <span className="entry-nav-rail__recent-chevron" aria-hidden>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        </span>
      </button>
      {/* The canonical disclosure pair (index.css / composio.css): the outer
          grid animates 0fr → 1fr, the inner box carries the clip. `hidden` on
          the wrapper would skip the transition entirely. */}
      <div className={`accordion-collapsible${open ? ' open' : ''}`}>
        <div className="accordion-collapsible-inner">
          <ul ref={recentListRef} className="entry-nav-rail__recent-list">
            {items.map((project) => {
              return (
                <li key={project.id} data-project-id={project.id}>
                  <RailRecentRow
                    project={project}
                    workspaceContext={workspaceContext}
                    runStatus={runStatusByProjectId.get(project.id)}
                    ownedBySelf={ownedBySelf(project.id)}
                    shared={isSharedProject(project.id)}
                    moveToTeamAvailable={false}
                    sharing={false}
                    shareError={null}
                    runId={project.status?.runId}
                    onOpen={openProject}
                    onRename={onRename}
                    onDuplicate={onDuplicate ? (target) => { void duplicateFlow.duplicate(target); } : undefined}
                    onDelete={onDelete ? deleteFlow.request : undefined}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      {deleteFlow.target ? (
        <ProjectDeleteConfirmDialog
          projectName={deleteFlow.target.name}
          pending={deleteFlow.pending}
          failed={deleteFlow.failed}
          onCancel={deleteFlow.cancel}
          onConfirm={() => void deleteFlow.commit()}
        />
      ) : null}
    </div>
  );
}

interface EntryTopRightClusterProps {
  updaterSlot?: ReactNode;
}

/** The updater stays in the existing no-drag chrome host. */
export function EntryTopRightCluster({ updaterSlot }: EntryTopRightClusterProps) {
  const [host, setHost] = useState<HTMLElement | null>(workspaceChromeAccountActionsHost);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => { setHost(workspaceChromeAccountActionsHost() ?? document.body); }, []);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const refresh = () => setVisible(slot.childElementCount > 0);
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(slot, { childList: true });
    return () => observer.disconnect();
  }, [host]);
  if (!host) return null;
  return createPortal(
    <div className={visible ? 'entry-top-right-cluster' : undefined}>
      <div
        ref={slotRef}
        className="entry-nav-rail__account-updater"
        data-testid={visible ? 'entry-nav-account-updater' : undefined}
      >
        {updaterSlot}
      </div>
    </div>,
    host,
  );
}

export function WorkspaceTopRightAccountCluster({ updaterSlot }: EntryTopRightClusterProps) {
  return <EntryTopRightCluster updaterSlot={updaterSlot} />;
}

function XMark({ size }: { size: number }) {
  return (
    <svg
      className="entry-nav-rail__menu-x"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path
        d="M10.4883 14.651L15.25 21H22.25L14.3917 10.5223L20.9308 3H18.2808L13.1643 8.88578L8.75 3H1.75L9.26086 13.0145L2.31915 21H4.96917L10.4883 14.651ZM16.25 19L5.75 5H7.75L18.25 19H16.25Z"
      />
    </svg>
  );
}

/**
 * Community / contact links (Discord / X / mail), icon only (OPEND-3180).
 *
 * The local dock shows this row above its Settings control.
 * The glyph is all a sighted user sees — the name lives on
 * `aria-label` and rides the shared `.od-tooltip` layer on hover, so the icon
 * still explains itself without a label beside it.
 */
function RailSocialRow({
  page,
  dimensions,
}: {
  page: TrackingWorkspacePage;
  dimensions: ReturnType<typeof workspaceAnalyticsDimensions>;
}) {
  const { t, locale } = useI18n();
  const analytics = useAnalytics();
  // The rail sits on the leading edge, so tooltips open away from it —
  // right in LTR, left once RTL moves the whole rail to the right edge.
  // Without the flip the bubble would be clamped against the viewport
  // and land back on top of the icons it describes.
  const tooltipPlacement = isRtlLocale(locale) ? 'left' : 'right';
  // One string per link doubles as the accessible name and the hover
  // tooltip: the bubble is the only place the icons say what they do, so
  // the copy leads with the payoff (Discord hands out credits) rather
  // than naming the destination.
  const communityLabel = t('entry.discordAria');
  const xLabel = t('entry.xAria');
  const mailLabel = t('entry.mailAria');
  const btnClass = 'entry-nav-rail__menu-social-btn od-tooltip';
  const hint = (label: string) => ({
    'data-tooltip': label,
    'data-tooltip-placement': tooltipPlacement,
  });
  const glyph = 16;

  function track(element: AccountMenuClickProps['element']) {
    trackAccountMenuClick(analytics.track, {
      page_name: page,
      area: 'account_menu',
      element,
      ...dimensions,
    });
  }

  return (
    <div className="entry-nav-rail__menu-social" data-testid="entry-nav-rail-social">
      <a
        className={btnClass}
        href={DISCORD_URL}
        {...externalLinkProps}
        aria-label={communityLabel}
        {...hint(communityLabel)}
        data-testid="entry-nav-rail-discord"
        onClick={() => track('discord')}
      >
        <Icon name="discord" size={glyph} />
      </a>
      <a
        className={btnClass}
        href={X_URL}
        {...externalLinkProps}
        aria-label={xLabel}
        {...hint(xLabel)}
        onClick={() => track('twitter')}
      >
        <XMark size={glyph} />
      </a>
      <a
        className={btnClass}
        href={CONTACT_EMAIL_URL}
        aria-label={mailLabel}
        {...hint(mailLabel)}
        onClick={() => track('email')}
      >
        <Icon name="mail" size={glyph} />
      </a>
    </div>
  );
}

export function EntryNavRail({
  view,
  onViewChange,
  open,
  context,
  onOpenSettings,
  updaterSlot,
  recentProjects,
  onOpenRecentProject,
  onRenameRecentProject,
  onDeleteRecentProject,
  onDuplicateRecentProject,
  isSharedRecentProject,
  recentProjectOwnerMemberIds,
}: Props) {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const analyticsPage = entryViewToTracking(view);
  const workspaceDimensions = workspaceAnalyticsDimensions(context);
  const openSettings = () => {
    trackAccountMenuClick(analytics.track, {
      page_name: analyticsPage,
      area: 'account_menu',
      element: 'settings',
    });
    onOpenSettings?.();
  };
  const selectView = (next: EntryView) => {
    trackEntryNavigationClick(analytics.track, {
      page_name: analyticsPage,
      area: 'entry_nav',
      element: 'nav_item',
      target: entryViewToTracking(next),
      entry_from: 'sidebar',
      ...workspaceDimensions,
    });
    onViewChange(next);
  };

  // While collapsed the rail is visually hidden but its controls stay mounted;
  // mark it `inert` so they leave the tab order and pointer flow entirely.
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = railRef.current;
    if (!node) return;
    if (open) {
      node.removeAttribute('inert');
    } else {
      node.setAttribute('inert', '');
    }
  }, [open]);

  return (
    <nav
      ref={railRef}
      className={`entry-nav-rail${open ? ' is-open' : ''}`}
      aria-label={t('entry.primaryNavAria')}
      aria-hidden={open ? undefined : true}
    >
      <div className="entry-nav-rail__panel">
        <div className="entry-nav-rail__group">
          <NavButton
            active={view === 'home'}
            ariaLabel={t('entry.navRecents')}
            label={t('entry.navRecents')}
            onClick={() => selectView('home')}
            testId="entry-nav-home"
          >
            <Icon name="home" size={16} />
          </NavButton>
          <NavButton
            active={view === 'community'}
            ariaLabel={t('pluginsHome.title')}
            label={t('pluginsHome.title')}
            onClick={() => selectView('community')}
            testId="entry-nav-community"
          >
            <Icon name="globe" size={16} />
          </NavButton>
          <div className="entry-nav-rail__team-section">
            <NavButton
              active={view === 'drafts' || view === 'all-projects'}
              ariaLabel={t('entry.navDrafts')}
              label={t('workspaceSwitcher.draftsTooltip')}
              onClick={() => selectView('drafts')}
              testId="entry-nav-drafts"
            >
              <Icon name="file" size={16} />
            </NavButton>
            <NavButton
              active={view === 'design-systems'}
              ariaLabel={t('entry.navDesignSystems')}
              label={t('entry.navDesignSystems')}
              onClick={() => selectView('design-systems')}
              testId="entry-nav-design-systems"
            >
              <Icon name="palette" size={16} />
            </NavButton>
            <NavButton
              active={view === 'plugins'}
              ariaLabel={t('entry.navPlugins')}
              label={t('entry.navPlugins')}
              onClick={() => selectView('plugins')}
              testId="entry-nav-plugins"
            >
              <Icon name="puzzle" size={16} />
            </NavButton>
            <NavButton
              ariaLabel={t('entry.accountSettings')}
              label={t('entry.accountSettings')}
              onClick={openSettings}
              testId="entry-settings-button"
            >
              <Icon name="settings" size={16} />
            </NavButton>
            <RailRecentSection
              projects={context?.workspaceType === 'team' ? [] : recentProjects ?? []}
              onOpen={onOpenRecentProject}
              onRename={onRenameRecentProject}
              onDelete={onDeleteRecentProject}
              onDuplicate={onDuplicateRecentProject}
              isShared={isSharedRecentProject}
              ownerMemberIds={recentProjectOwnerMemberIds}
              workspaceContext={context}
              analyticsPage={analyticsPage}
              label={t('recentProjects.title')}
            />
          </div>
        </div>
        <div className="entry-nav-rail__footer">
          <div className="entry-nav-rail__account-dock entry-nav-rail__account-dock--local" data-testid="entry-nav-local-account-dock">
            <RailSocialRow page={analyticsPage} dimensions={workspaceDimensions} />
            <div className="entry-nav-rail__account">
              <button
                type="button"
                className="entry-nav-rail__account-trigger"
                aria-label={t('entry.accountSettings')}
                title={t('entry.accountSettings')}
                data-testid="entry-nav-local-account"
                onClick={openSettings}
              >
                <span className="entry-nav-rail__account-avatar entry-nav-rail__account-avatar--local" aria-hidden>
                  <Icon name="terminal" size={14} />
                </span>
                <span className="entry-nav-rail__account-name">{t('entry.localAccountName')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <EntryTopRightCluster updaterSlot={updaterSlot} />
    </nav>
  );
}
