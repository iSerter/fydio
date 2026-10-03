/**
 * T01 placeholder build for the Chrome MV3 extension.
 *
 * A real bundler is overkill while there is no extension code to bundle; this
 * copies the static extension assets and asserts the manifest is loadable. T10
 * replaces it with a proper bundle step.
 *
 * `outputFileTracing`-free on purpose: the result is a directory Chrome loads
 * unpacked, not a single file.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(packageRoot, 'public')
const outDir = join(packageRoot, 'dist')

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  await cp(source, outDir, { recursive: true })

  // Fail the build on a malformed manifest rather than at `chrome://extensions`
  // load time, where the error message is far worse.
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  if (manifest.manifest_version !== 3) {
    throw new Error(`expected manifest_version 3, found ${String(manifest.manifest_version)}`)
  }

  if (typeof manifest.background?.service_worker !== 'string') {
    throw new Error('manifest is missing background.service_worker')
  }

  const stamp = {
    name: manifest.name,
    version: manifest.version,
    builtAt: new Date().toISOString(),
    note: 'T01 placeholder build — real extension ships in T10',
  }

  await writeFile(join(outDir, 'build-info.json'), `${JSON.stringify(stamp, null, 2)}\n`)

  process.stdout.write(`extension built -> ${outDir}\n`)
}

await main()
