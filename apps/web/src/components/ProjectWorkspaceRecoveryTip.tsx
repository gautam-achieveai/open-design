import { useT } from '../i18n';
import styles from './ProjectWorkspaceRecoveryTip.module.css';

/**
 * Keep a transient Workspace authority outage visible without replacing the
 * healthy local project data plane. This status does not start account login.
 */
export function ProjectWorkspaceRecoveryTip() {
  const t = useT();
  return (
    <div className={styles.root} data-testid="project-workspace-recovery-tip">
      <div className="entry-rail-account-recovery" role="status" aria-live="polite">
        <span className="entry-rail-account-recovery__spinner" aria-hidden />
        <span className="entry-rail-account-recovery__text">{t('entry.cloudRecovering')}</span>
      </div>
    </div>
  );
}
