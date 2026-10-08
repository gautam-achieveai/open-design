import { Button } from '@open-design/components';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { commentTargetDisplayName } from '../../comments';
import type { Dict } from '../../i18n/types';
import type { ChatCommentAttachment } from '../../types';
import { Icon } from '../Icon';
import { chatSeam } from './ChatRoot';
import styles from './StagedCommentCard.module.css';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

/**
 * One staged pin in the composer: the element picture with the pin number
 * (`#N`, the canvas pin's `pinSeq`) and the note on one line. Click opens the
 * whole picture and note. A pin without a picture shows its target name.
 * `page` names the pin's page when another staged pin shares its number.
 */
export function StagedCommentCard({ attachment, imageUrl, page, onRemove, t }: {
  attachment: ChatCommentAttachment;
  imageUrl?: string;
  page?: string;
  onRemove: () => void;
  t: TranslateFn;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => setImageFailed(false), [imageUrl]);
  const name = commentTargetDisplayName(attachment);
  const seq = attachment.source === 'saved-comment' ? `#${attachment.order}` : null;
  const label = [seq, name, page ? `· ${page}` : null].filter(Boolean).join(' ');
  const showImage = Boolean(imageUrl) && !imageFailed;
  return (
    <span {...chatSeam(styles.card)} data-testid="staged-comment-card">
      <Button variant="ghost" className={styles.open} onClick={() => setPreviewOpen(true)}
        title={attachment.comment ? `${label}: ${attachment.comment}` : label}
        aria-label={t('chat.attachments.preview', { name: label })}>
        <span className={styles.frame}>
          {showImage
            ? <img src={imageUrl} alt="" aria-hidden onError={() => setImageFailed(true)} />
            : <span className={styles.fallback}>{attachment.currentText?.trim() || name}</span>}
        </span>
        <span className={styles.note}>{attachment.comment}</span>
        {page ? <span className={styles.page} data-testid="staged-comment-page">{page}</span> : null}
        {seq ? <span className={styles.seq} data-testid="staged-comment-seq">{seq}</span> : null}
      </Button>
      <Button variant="ghost" className={styles.remove} onClick={onRemove}
        title={t('chat.comments.removeAttachment')}
        aria-label={t('chat.comments.removeAttachmentAria', { name: label })}>
        <Icon name="close" size={12} />
      </Button>
      {previewOpen ? createPortal(
        <div {...chatSeam('staged-preview-modal')} role="dialog" aria-modal="true" aria-label={label}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setPreviewOpen(false); } }}
          onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewOpen(false); }}>
          <div className="staged-preview-card">
            <div className="staged-preview-head">
              <span title={label}>{label}</span>
              <Button variant="ghost" autoFocus onClick={() => setPreviewOpen(false)}
                aria-label={t('common.close')}><Icon name="close" size={14} /></Button>
            </div>
            <div className={styles.details}>
              {showImage ? <img src={imageUrl} alt={label} /> : null}
              {attachment.comment ? <p>{attachment.comment}</p> : null}
              <p className={styles.target}>{attachment.selector || name}</p>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
