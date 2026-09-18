/**
 * Windows filesystem compatibility shim (preloaded by `tools/overlay.mjs`
 * through NODE_OPTIONS, so test-runner child processes inherit it).
 *
 * Upstream's ACP provider kills its child process and immediately removes the
 * temporary working directory. On Windows the killed child still holds a
 * handle to its cwd for a short moment, so `fs.rm` fails with EBUSY; upstream
 * then reports that filesystem error instead of the real failure and leaves
 * the temp directory behind. The tests in `server/providers/providers.test.ts`
 * (and manual `scripts/compare-reasoning.ts` runs) hit exactly this.
 *
 * Retrying the removal is the fix, but it must not live in upstream's source:
 * patching the builtin here keeps `server/providers/codex.ts` byte-identical to
 * upstream while still giving Node's ESM import of `node:fs/promises` the
 * retrying implementation (`syncBuiltinESMExports` refreshes the bindings).
 *
 * This file is local-only and has no effect on non-Windows platforms. Plain
 * `npm test` is upstream's command and runs without this shim — use
 * `node tools/overlay.mjs test` (same patterns, shim preloaded) when the ACP
 * cleanup tests misfire with EBUSY.
 */
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'])
const MAX_ATTEMPTS = 20
const RETRY_DELAY_MS = 100

if (process.platform === 'win32') {
  const retrying = (remove) => async (target, options) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await remove(target, options)
      } catch (error) {
        const code = error && typeof error === 'object' ? error.code : undefined
        if (!RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS) throw error
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      }
    }
  }

  const rmPromise = retrying(fsPromises.rm.bind(fsPromises))
  fsPromises.rm = rmPromise

  const originalRm = fs.rm.bind(fs)
  const rmCallback = promisify(originalRm)
  fs.rm = function rmWithRetry(target, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    const result = rmCallback(target, options)
    if (typeof callback === 'function') {
      result.then(
        () => callback(null),
        (error) => callback(error),
      )
      return undefined
    }
    return result
  }

  syncBuiltinESMExports()
}

