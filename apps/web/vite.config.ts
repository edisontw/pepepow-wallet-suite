import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from "vite-plugin-wasm";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [react(), wasm(), nodePolyfills()],
  define: { global: "globalThis" },
  server: { port: 5173 },
  build: { outDir: 'dist', target: "esnext" },
  resolve: { preserveSymlinks: true }
})
