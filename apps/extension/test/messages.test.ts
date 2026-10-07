import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '../src/api'
import {
  finishTracking,
  handleOutboundClick,
  setApiBaseUrl,
  startTracking,
} from '../src/background'
import { clearConsent, CONSENT_KEY, CONSENT_VERSION, isConsented, setConsent } from '../src/consent'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// In-memory mock chrome storage
const mockStorage = new Map<string, unknown>()

// Setup global mock for chrome extension APIs
globalThis.chrome = {
  storage: {
    local: {
      get: vi.fn((key: string) => Promise.resolve({ [key]: mockStorage.get(key) })),
      set: vi.fn((items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) {
          mockStorage.set(k, v)
        }
        return Promise.resolve()
      }),
      remove: vi.fn((key: string) => {
        mockStorage.delete(key)
        return Promise.resolve()
      }),
    },
  },
  tabs: {
    onActivated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    create: vi.fn(),
  },
  runtime: {
    onMessageExternal: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
  },
} as unknown as typeof chrome

interface ManifestShape {
  readonly manifest_version: number
  readonly permissions?: string[]
  readonly host_permissions?: string[]
}

describe('Extension manifest and permissions security', () => {
  it('asserts that no broad or forbidden permissions exist in manifest.json', () => {
    const manifestPath = join(ROOT, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestShape

    const forbidden = [
      '<all_urls>',
      'webRequest',
      'cookies',
      'history',
      'bookmarks',
      'desktopCapture',
      'debugger',
    ]

    const allPermissions = [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])]

    for (const bad of forbidden) {
      const found = allPermissions.some((perm: string) => perm.includes(bad))
      expect(found, `Forbidden permission "${bad}" must not be present`).toBe(false)
    }

    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['storage', 'activeTab', 'tabs', 'alarms']),
    )
    expect(manifest.manifest_version).toBe(3)
  })
})

describe('Consent lifecycle', () => {
  beforeEach(() => {
    mockStorage.clear()
  })

  it('defaults to not consented when storage is empty', async () => {
    expect(await isConsented()).toBe(false)
  })

  it('grants consent with the correct version and timestamp', async () => {
    await setConsent(true)
    expect(await isConsented()).toBe(true)

    const stored = mockStorage.get(CONSENT_KEY) as
      | {
          granted: boolean
          version: string
          at: number
        }
      | undefined

    expect(stored?.granted).toBe(true)
    expect(stored?.version).toBe(CONSENT_VERSION)
    expect(typeof stored?.at).toBe('number')
  })

  it('revokes consent immediately upon setConsent(false)', async () => {
    await setConsent(true)
    expect(await isConsented()).toBe(true)

    await setConsent(false)
    expect(await isConsented()).toBe(false)
  })

  it('clears consent storage cleanly', async () => {
    await setConsent(true)
    await clearConsent()
    expect(await isConsented()).toBe(false)
    expect(mockStorage.has(CONSENT_KEY)).toBe(false)
  })
})

describe('Service worker message handling and duration reporting', () => {
  beforeEach(() => {
    mockStorage.clear()
    setApiBaseUrl('http://localhost:3000')
    vi.restoreAllMocks()
  })

  it('does NOT send duration events when consent is OFF', async () => {
    const postSpy = vi.spyOn(api, 'postDurationEvent').mockResolvedValue({
      success: true,
      status: 201,
    })

    await setConsent(false)

    await handleOutboundClick({
      entryId: '00000000-0000-0000-0000-000000000001',
      token: 'fake-token',
    })

    // Finish tracking directly
    const band = await finishTracking(false)

    expect(band).toBeNull()
    expect(postSpy).not.toHaveBeenCalled()
  })

  it('reports coarse band without raw duration when consent is ON', async () => {
    const postSpy = vi.spyOn(api, 'postDurationEvent').mockResolvedValue({
      success: true,
      status: 201,
    })

    await setConsent(true)

    await handleOutboundClick({
      entryId: '00000000-0000-0000-0000-000000000001',
      token: 'valid-extension-token',
    })

    // Simulate switching to opened tab
    startTracking(999)

    const band = await finishTracking(true)

    expect(band).toBe('lt_15s')
    expect(postSpy).toHaveBeenCalledTimes(1)

    const callArgs = postSpy.mock.calls[0]
    expect(callArgs).toBeDefined()
    if (!callArgs) return

    const [apiUrl, token, payload] = callArgs
    expect(apiUrl).toBe('http://localhost:3000')
    expect(token).toBe('valid-extension-token')

    // Strict payload shape assertion:
    expect(Object.keys(payload).sort()).toEqual(['band', 'entryId', 'returned'].sort())
    expect(payload.entryId).toBe('00000000-0000-0000-0000-000000000001')
    expect(payload.band).toBe('lt_15s')
    expect(payload.returned).toBe(true)

    // Security assertion: NO raw millisecond count or URL
    const record = payload as unknown as Record<string, unknown>
    expect(record.durationMs).toBeUndefined()
    expect(record.ms).toBeUndefined()
    expect(record.url).toBeUndefined()
  })
})
