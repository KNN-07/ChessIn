import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
export default defineConfig({
  plugins: [react(), VitePWA({
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.ts',
    registerType: 'prompt',
    injectRegister: null,
    injectManifest: {
      globIgnores: ['**/engines/**', '**/sources/**', '**/*.nnue', '**/*.tar.gz', '**/THIRD-PARTY-NOTICES.txt'],
    },
    manifest: {
      name: 'ChessIn — Chess Analysis',
      short_name: 'ChessIn',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#161815',
      background_color: '#161815',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    includeAssets: ['icons/apple-touch-icon.png'],
  })],
  server: { port: 5173, headers },
  preview: { port: 4173, headers },
});
