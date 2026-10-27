import type { NextConfig } from 'next';
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

type WebpackHook = NonNullable<NextConfig['webpack']>;
type WebpackConfig = Parameters<WebpackHook>[0];
type WebpackContext = Parameters<WebpackHook>[1];

function configureCache(dev: boolean, cache: WebpackConfig['cache']) {
  const configureWebpack = nextConfig.webpack as WebpackHook;
  return configureWebpack({ cache } as WebpackConfig, { dev } as WebpackContext).cache;
}

describe('development webpack cache', () => {
  it('uses memory instead of serializing a persistent cache while idle', () => {
    expect(configureCache(true, { type: 'filesystem' })).toEqual({ type: 'memory' });
  });

  it('preserves the production cache configuration', () => {
    const productionCache: WebpackConfig['cache'] = { type: 'filesystem' };
    expect(configureCache(false, productionCache)).toBe(productionCache);
  });
});
