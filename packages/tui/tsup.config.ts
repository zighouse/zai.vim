import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { cli: 'src/index.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  shims: true,
});
