// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMockOpenDesignHost } from '@open-design/host/testing';

const {
  createSession,
  executeOperation,
  stopSession,
  updateTarget,
} = vi.hoisted(() => ({
  createSession: vi.fn(),
  executeOperation: vi.fn(),
  stopSession: vi.fn(async () => {}),
  updateTarget: vi.fn(),
}));

vi.mock('../../src/runtime/embedded-browser-control', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/embedded-browser-control')>(
    '../../src/runtime/embedded-browser-control',
  );
  return {
    ...actual,
    createEmbeddedBrowserControlSession: createSession,
    executeEmbeddedBrowserOperation: executeOperation,
  };
});

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    openExternalUrl: vi.fn(async () => true),
    writeProjectTextFile: vi.fn(async () => null),
    writeProjectBase64File: vi.fn(async () => null),
  };
});

import { DesignBrowserPanel } from '../../src/components/DesignBrowserPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let restoreHost: (() => void) | null = null;

beforeEach(() => {
  createSession.mockReset();
  stopSession.mockClear();
  updateTarget.mockClear();
  executeOperation.mockReset();
  executeOperation.mockImplementation(async (_projectId, command) => ({
    commandId: `command-${command.operation}`,
    tab: {
      projectId: 'project-browser-control',
      tabId: 'browser-tab-7',
      title: 'Example',
      url: 'https://example.com/path',
    },
    result: command.operation === 'network-list'
      ? {
          operation: 'network-list',
          entries: [{
            method: 'GET',
            requestId: 'request-1',
            responseStatus: 200,
            url: 'https://example.com/api/items',
          }],
        }
      : {
          operation: 'console',
          entries: [{ level: 'info', text: 'page-ready' }],
        },
  }));
  createSession.mockImplementation(({ onStatus }) => {
    onStatus?.('connected');
    return {
      ready: Promise.resolve(true),
      stop: stopSession,
      updateTarget,
    };
  });
  restoreHost = installMockOpenDesignHost();
});

afterEach(() => {
  cleanup();
  restoreHost?.();
  restoreHost = null;
});

describe('DesignBrowserPanel browser control', () => {
  it('loads external https in the correct partition and registers the exact guest tab', async () => {
    const view = render(
      <DesignBrowserPanel
        projectId="project-browser-control"
        browserTabId="browser-tab-7"
        browserTabActive
        initialTitle="Example"
        initialUrl="https://example.com/path"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );
    const webview = view.container.querySelector('webview.db-webview') as HTMLElement & {
      executeJavaScript?: (code: string) => Promise<unknown>;
      getTitle?: () => string;
      getURL?: () => string;
      getWebContentsId?: () => number;
      isLoading?: () => boolean;
    };
    webview.executeJavaScript = vi.fn(async (code: string) => (
      code.includes('cursor: crosshair')
        ? {
            filePath: 'https://example.com/path',
            elementId: 'dom:button:nth-of-type(1)',
            selector: 'button:nth-of-type(1)',
            label: 'button.primary',
            text: 'Continue',
            position: { x: 20, y: 30, width: 120, height: 40 },
            hoverPoint: { x: 35, y: 45 },
            htmlHint: '<button class="primary">',
            style: {
              color: 'rgb(255, 255, 255)',
              backgroundColor: 'rgb(0, 0, 0)',
              fontSize: '14px',
            },
            selectionKind: 'element',
          }
        : null
    ));
    webview.getTitle = () => 'Example';
    webview.getURL = () => 'https://example.com/path';
    webview.getWebContentsId = () => 701;
    webview.isLoading = () => false;

    expect(webview.getAttribute('src')).toBe('https://example.com/path');
    expect(webview.getAttribute('partition')).toBe('persist:open-design-design-browser');

    act(() => {
      webview.dispatchEvent(new Event('dom-ready'));
    });

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
        target: {
          active: true,
          projectId: 'project-browser-control',
          tabId: 'browser-tab-7',
          title: 'Example',
          url: 'https://example.com/path',
          webContentsId: 701,
        },
      }));
    });
    expect(screen.getByRole('button', { name: 'AI · active' })).toBeTruthy();
    expect(view.container.querySelector('.db-ai-control-dot')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Annotate' }));
    await waitFor(() => {
      expect(webview.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('cursor: crosshair'),
        true,
      );
    });
    expect(screen.getByRole('button', { name: 'Annotate' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'AI · active' }));
    await waitFor(() => {
      expect(screen.getByText('/api/items')).toBeTruthy();
      expect(screen.getByText('page-ready')).toBeTruthy();
    });
    expect(executeOperation).toHaveBeenCalledWith(
      'project-browser-control',
      { operation: 'network-list', limit: 50 },
      expect.objectContaining({ tabId: 'browser-tab-7', timeoutMs: 10_000 }),
    );

    view.rerender(
      <DesignBrowserPanel
        projectId="project-browser-control"
        browserTabId="browser-tab-7"
        browserTabActive={false}
        initialTitle="Example"
        initialUrl="https://example.com/path"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );
    await waitFor(() => {
      expect(updateTarget).toHaveBeenLastCalledWith(expect.objectContaining({
        active: false,
        tabId: 'browser-tab-7',
        webContentsId: 701,
      }));
    });
    expect(screen.getByRole('button', { name: 'AI · inactive' })).toBeTruthy();

    view.unmount();
    expect(stopSession).toHaveBeenCalledTimes(1);
  });

  it('leaves the iframe fallback unchanged and does not pretend control is connected', () => {
    restoreHost?.();
    restoreHost = null;

    const view = render(
      <DesignBrowserPanel
        projectId="project-browser-fallback"
        browserTabId="browser-tab-fallback"
        initialUrl="https://example.com/external"
        onOpenFile={() => {}}
        onRefreshFiles={() => {}}
      />,
    );

    expect(view.container.querySelector('iframe')?.getAttribute('src')).toBe(
      'https://example.com/external',
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(view.container.querySelector('.db-ai-control')).toBeNull();
  });
});
