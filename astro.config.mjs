import { defineConfig } from 'astro/config';
export default defineConfig({
  site: 'https://apexbranding.design',
  base: process.env.PAGES_BASE || '/',
  build: { format: 'directory' }
});
