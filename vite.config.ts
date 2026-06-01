import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import preact from '@preact/preset-vite'
import manifest from './manifest.json'

export default defineConfig({
  plugins: [preact(), crx({ manifest })],
  build: {
    rollupOptions: {
      // Include the offscreen document as a separate entry point alongside
      // the manifest-defined entries that CRXJS manages.
      input: {
        offscreen: 'src/offscreen/index.html',
      },
    },
  },
})
