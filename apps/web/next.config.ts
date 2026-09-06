import type { NextConfig } from 'next';
import { resolve } from 'node:path';
const config: NextConfig = {
  transpilePackages: ['@carrier/contracts'],
  turbopack: { root: resolve(import.meta.dirname, '../..') },
};
export default config;
