import { useCallback, useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import type { ClaudeCodePluginSummary, ClaudeCodePluginsResponse } from '@open-design/contracts';

import { useT } from '../i18n';
import {
  fetchClaudeCodePlugins,
  type ClaudeCodePluginsLoad,
} from '../state/claude-code-plugins';
import styles from './ClaudeCodePluginsPanel.module.css';

/**
 * Plugins → "From Claude Code". Read-only: Claude Code loads these plugins
 * itself when OpenDesign runs it, so this tab only shows what is installed.
 */
export function ClaudeCodePluginsPanel({
  load = fetchClaudeCodePlugins,
}: {
  load?: () => Promise<ClaudeCodePluginsLoad>;
}) {
  const t = useT();
  // null while a load is in flight.
  const [state, setState] = useState<ClaudeCodePluginsLoad | null>(null);

  const reload = useCallback(() => {
    let cancelled = false;
    setState(null);
    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => reload(), [reload]);

  return (
    <section className="plugins-view__section" aria-labelledby="plugins-claude-code-title">
      <div className="plugins-view__section-head">
        <div>
          <h2 id="plugins-claude-code-title">{t('pluginsView.claudeCode.title')}</h2>
          <p>{t('pluginsView.claudeCode.subtitle')}</p>
        </div>
      </div>
      {state === null ? (
        <div className="plugins-view__empty">{t('pluginsView.claudeCode.loading')}</div>
      ) : null}
      {state && !state.ok ? (
        <div className={styles.error} role="alert">
          <span>{t('pluginsView.claudeCode.error', { message: state.message })}</span>
          <Button size="sm" onClick={() => reload()}>
            {t('pluginsView.claudeCode.retry')}
          </Button>
        </div>
      ) : null}
      {state?.ok ? <ClaudeCodePluginsList data={state.data} /> : null}
    </section>
  );
}

export function ClaudeCodePluginsList({ data }: { data: ClaudeCodePluginsResponse }) {
  const t = useT();
  if (!data.available) {
    return (
      <div className="plugins-view__empty" data-testid="claude-code-plugins-unavailable">
        {t('pluginsView.claudeCode.unavailable', { dir: data.configDir })}
      </div>
    );
  }
  const enabledCount = data.plugins.filter((p) => p.enabled).length;
  return (
    <div className={styles.root} data-testid="claude-code-plugins">
      <h3 className={styles.heading}>{t('pluginsView.claudeCode.marketplaces')}</h3>
      <ul className={styles.marketplaces}>
        {data.marketplaces.map((m) => (
          <li key={m.name} className={styles.marketplace}>
            <span className={styles.name}>{m.name}</span>
            <span className={styles.badge}>{m.sourceKind}</span>
            <span className={styles.muted} title={m.sourceLabel}>{m.sourceLabel}</span>
          </li>
        ))}
      </ul>

      <h3 className={styles.heading}>
        {t('pluginsView.claudeCode.plugins', { enabled: enabledCount, total: data.plugins.length })}
      </h3>
      {data.plugins.length === 0 ? (
        <div className="plugins-view__empty">{t('pluginsView.claudeCode.empty')}</div>
      ) : (
        <ul className={styles.plugins}>
          {data.plugins.map((plugin) => (
            <ClaudeCodePluginRow key={plugin.id} plugin={plugin} />
          ))}
        </ul>
      )}

      {data.warnings.length > 0 ? (
        <details className={styles.warnings}>
          <summary>{t('pluginsView.claudeCode.warnings', { count: data.warnings.length })}</summary>
          <ul>
            {data.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ClaudeCodePluginRow({ plugin }: { plugin: ClaudeCodePluginSummary }) {
  const t = useT();
  return (
    <li className={styles.plugin} data-testid={`claude-code-plugin-${plugin.id}`}>
      <div className={styles.pluginHead}>
        <span className={styles.name}>{plugin.name}</span>
        <span className={styles.muted}>@{plugin.marketplace}</span>
        {plugin.version ? <span className={styles.muted}>v{plugin.version}</span> : null}
        <span className={plugin.enabled ? styles.badgeOn : styles.badge}>
          {plugin.enabled ? t('pluginsView.claudeCode.enabled') : t('pluginsView.claudeCode.disabled')}
        </span>
        {plugin.installPath ? null : (
          <span className={styles.badge}>{t('pluginsView.claudeCode.notInstalled')}</span>
        )}
      </div>
      {plugin.description ? <p className={styles.description}>{plugin.description}</p> : null}
      <div className={styles.muted}>
        {t('pluginsView.claudeCode.counts', {
          skills: plugin.skills.length,
          commands: plugin.commands.length,
          agents: plugin.agents.length,
        })}
      </div>
      {plugin.skills.length > 0 ? (
        <details className={styles.skills}>
          <summary>{t('pluginsView.claudeCode.skillsSummary', { count: plugin.skills.length })}</summary>
          <ul>
            {plugin.skills.map((skill, i) => (
              <li key={`${skill.name}-${i}`}>
                <span className={styles.name}>{skill.name}</span>
                {skill.description ? <span className={styles.muted}> {skill.description}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}
