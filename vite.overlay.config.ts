// Root shim for the overlay Vite config. The implementation lives under
// server/overlay/ so the project's tsconfig checks it; this file only exists so
// the conventional root-level name works with `vite --config`.
export { default } from './server/overlay/vite-config.ts'
