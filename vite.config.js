import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// pst-extractor is a Node library (Buffer, fs for the file-path mode we don't
// use); the polyfills let it run in the browser and in the web worker.
const polyfills = () =>
  nodePolyfills({
    globals: { Buffer: true, global: true, process: true },
  })

export default defineConfig({
  base: './',
  plugins: [polyfills()],
  worker: {
    format: 'es',
    plugins: () => [polyfills()],
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
})
