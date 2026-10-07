import { describe, expect, it } from 'vitest'

import { GET } from '@/app/api/health/route'

describe('/api/health route handler', () => {
  it('returns 200 with database status connected and current migration head', async () => {
    const response = await GET()

    expect(response.status).toBe(200)

    const data = (await response.json()) as {
      ok: boolean
      status: string
      database: string
      migrationHead: string
      timestamp: string
    }

    expect(data.ok).toBe(true)
    expect(data.status).toBe('healthy')
    expect(data.database).toBe('connected')
    expect(typeof data.migrationHead).toBe('string')
    expect(data.migrationHead).toMatch(/^00\d{2}$/)
    expect(data.migrationHead).toBe('0030')
    expect(typeof data.timestamp).toBe('string')
  })
})
