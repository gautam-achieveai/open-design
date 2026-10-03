// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardComposerPopover } from '../../src/components/BoardComposerPopover';

afterEach(cleanup);

type Props = ComponentProps<typeof BoardComposerPopover>;
function Harness({ overrides = {} }: { overrides?: Partial<Props> }) {
  const [draft, setDraft] = useState('Make this calmer');
  const compactProps = { compact: true, styleEditor: <input aria-label="Text color" defaultValue="#000000" /> };
  return <BoardComposerPopover
    target={{ filePath: 'index.html', elementId: 'heading', selector: 'h1', label: 'h1', text: 'Hello', position: { x: 20, y: 30, width: 100, height: 30 }, htmlHint: '', selectionKind: 'element' }}
    existing={null} draft={draft} notes={[]} onDraft={setDraft} onAddDraft={() => {}}
    onRemoveQueuedNote={() => {}} onClose={() => {}} onSaveComment={() => {}}
    onSendBatch={() => {}} onRemoveMember={() => {}} sending={false} postOnly queueOnSend
    t={((key: string) => key) as Props['t']} {...compactProps} {...overrides}
  />;
}

describe('compact browser annotation composer', () => {
  it('opens the supplied editor, preserves the draft and closes expansion before annotation', () => {
    const onClose = vi.fn();
    render(<Harness overrides={{ onClose }} />);
    expect(screen.queryByLabelText('Text color')).toBeNull();
    expect(screen.queryByTestId('comment-popover-style-summary')).toBeNull();
    const input = screen.getByTestId('comment-popover-input');
    fireEvent.change(input, { target: { value: 'Keep the new draft' } });
    const styles = screen.getByRole('button', { name: 'designBrowser.edge.styles' });
    fireEvent.click(styles);
    expect(screen.getByLabelText('Text color')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Text color')).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe('Keep the new draft');
    expect(document.activeElement).toBe(styles);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('discloses attachments on demand with working preview/removal and retained send', () => {
    const onPreviewImage = vi.fn();
    const onRemoveImage = vi.fn();
    const onSendBatch = vi.fn();
    render(<Harness overrides={{ images: [{ file: new File([], 'crop.png'), url: 'blob:crop' }], imageDisclosure: 'Private text hidden', onPreviewImage, onRemoveImage, onSendBatch }} />);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'chat.annotationAttachImage (1)' }));
    expect(screen.getByRole('status').textContent).toBe('Private text hidden');
    fireEvent.click(screen.getByRole('button', { name: 'crop.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'chat.annotationAttachedRemove' }));
    expect(onPreviewImage).toHaveBeenCalledWith(0);
    expect(onRemoveImage).toHaveBeenCalledWith(0);
    fireEvent.keyDown(screen.getByTestId('comment-popover-input'), { key: 'Escape' });
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByTestId('comment-add-send'));
    expect(onSendBatch).toHaveBeenCalledTimes(1);
  });

  it('preserves post-only Enter, Shift+Enter, IME and external disabled gates', () => {
    const onSendBatch = vi.fn();
    const onClose = vi.fn();
    const view = render(<Harness overrides={{ onSendBatch, onClose }} />);
    const input = screen.getByTestId('comment-popover-input');
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSendBatch).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSendBatch).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSendBatch).toHaveBeenCalledTimes(1);
    view.rerender(<Harness overrides={{ onSendBatch, sendDisabled: true }} />);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSendBatch).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('comment-add-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps permission restrictions and the legacy summary default', () => {
    const onSendBatch = vi.fn();
    const view = render(<Harness overrides={{ canEditComment: false, canSendToAgent: false, onSendBatch }} />);
    expect((screen.getByTestId('comment-popover-input') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByTestId('comment-add-send')).toBeNull();
    expect(screen.queryByRole('button', { name: 'designBrowser.edge.styles' })).toBeNull();
    fireEvent.keyDown(screen.getByTestId('comment-popover-input'), { key: 'Enter' });
    expect(onSendBatch).not.toHaveBeenCalled();
    view.rerender(<Harness overrides={{ compact: false }} />);
    expect(screen.getByTestId('comment-popover-style-summary')).toBeTruthy();
  });

  it('keeps an open editor disabled while posting and the comment/actions outside its scroller', () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'designBrowser.edge.styles' }));
    view.rerender(<Harness overrides={{ sending: true }} />);
    expect(screen.getByLabelText('Text color').matches(':disabled')).toBe(true);
    expect((screen.getByTestId('comment-popover-input') as HTMLTextAreaElement).readOnly).toBe(true);
    const body = screen.getByTestId('comment-popover').querySelector('.comment-popover-body');
    expect(body?.contains(screen.getByTestId('comment-popover-input'))).toBe(false);
    expect(body?.contains(screen.getByTestId('comment-add-send'))).toBe(false);
  });
});
