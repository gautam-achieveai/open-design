import { Button } from '@open-design/components';
import { useEffect, useState } from 'react';
import type { Dict } from '../../i18n/types';
import { Icon } from '../Icon';
import { chatSeam } from './ChatRoot';
import styles from './BrowserAnnotationDraftCard.module.css';

export function BrowserAnnotationDraftCard({ imageUrl, onPreview, onRemove, t }: {
  imageUrl?: string;
  onPreview: (trigger: HTMLElement) => void;
  onRemove: () => void;
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageUrl]);
  return (
    <span {...chatSeam(styles.card)} data-testid="staged-browser-annotation-image">
      <Button variant="ghost" className={styles.preview} onClick={(event) => onPreview(event.currentTarget)}
        aria-label={t('chat.attachments.preview', { name: t('chat.annotationAttachedImages') })}>
        {imageUrl && !imageFailed
          ? <img src={imageUrl} alt="" aria-hidden onError={() => setImageFailed(true)} />
          : <span className={styles.fallback}><Icon name="comment" size={18} />{t('connectors.unavailable')}</span>}
      </Button>
      <Button variant="ghost" className={styles.remove} onClick={onRemove}
        aria-label={t('chat.comments.removeAttachment')}><Icon name="close" size={10} /></Button>
    </span>
  );
}
