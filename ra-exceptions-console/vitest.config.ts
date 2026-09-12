import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    passWithNoTests: true,
    globals: true,
    environment: 'node',
    setupFiles: ['./client/src/test-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.databricks/**'],
    server: {
      deps: {
        // Pre-existing environment quirk (see resolve.alias below): force
        // @databricks/appkit-ui through Vite's resolver instead of Node's
        // native ESM loader, so the alias for the extensionless
        // echarts-for-react/esm/core import actually applies.
        inline: ['@databricks/appkit-ui'],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './client/src'),
      // Pre-existing environment quirk: this Vite/rolldown version resolves
      // extensionless deep imports inconsistently under Node 22's ESM loader.
      // @databricks/appkit-ui's chart module imports this exact subpath
      // without an extension; alias it to the real file so any test that
      // pulls in @databricks/appkit-ui/react (even for non-chart components,
      // since it's one barrel export) doesn't fail to resolve.
      'echarts-for-react/esm/core': path.resolve(__dirname, './node_modules/echarts-for-react/esm/core.js'),
    },
  },
});
