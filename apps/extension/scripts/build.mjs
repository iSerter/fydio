import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(packageRoot, 'src')
const publicDir = join(packageRoot, 'public')
const outDir = join(packageRoot, 'dist')

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // Bundle background service worker and popup scripts with esbuild
  await build({
    entryPoints: [join(srcDir, 'background.ts'), join(srcDir, 'popup.ts')],
    outdir: outDir,
    bundle: true,
    format: 'esm',
    target: ['chrome116'],
    platform: 'browser',
    sourcemap: false,
    minify: false,
  })

  // Copy popup.html
  await cp(join(publicDir, 'popup.html'), join(outDir, 'popup.html'))

  // Copy manifest.json
  const manifestSource = join(packageRoot, 'manifest.json')
  await cp(manifestSource, join(outDir, 'manifest.json'))

  // Assert manifest integrity and absence of forbidden permissions
  const manifestRaw = await readFile(join(outDir, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestRaw)

  if (manifest.manifest_version !== 3) {
    throw new Error(`expected manifest_version 3, got ${manifest.manifest_version}`)
  }

  const badPermissions = [
    '<all_urls>',
    'webRequest',
    'cookies',
    'history',
    'bookmarks',
    'desktopCapture',
    'debugger',
  ]
  const allPermissions = [...(manifest.permissions || []), ...(manifest.host_permissions || [])]

  const forbiddenFound = badPermissions.filter((bad) => allPermissions.some((p) => p.includes(bad)))

  if (forbiddenFound.length > 0) {
    throw new Error(`forbidden permissions present in manifest: ${forbiddenFound.join(', ')}`)
  }

  const stamp = {
    name: manifest.name,
    version: manifest.version,
    builtAt: new Date().toISOString(),
    status: 'T10 production extension bundle',
  }

  await writeFile(join(outDir, 'build-info.json'), `${JSON.stringify(stamp, null, 2)}\n`)

  process.stdout.write(`Extension successfully bundled to ${outDir}\n`)
}

await main()
