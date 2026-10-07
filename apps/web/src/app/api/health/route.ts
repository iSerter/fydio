import { NextResponse } from 'next/server'

import { createServiceClient } from '@fydio/supabase/service'

/**
 * Health check endpoint (T10).
 *
 * Checks database connectivity and retrieves the current migration head.
 * Verifies deploy health for Coolify and smoke testing.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  try {
    const service = createServiceClient()
    const { data: migrationHead, error } = await service.rpc('get_migration_head')

    if (error !== null) {
      console.error('Database health check failed:', error.message)

      return NextResponse.json(
        {
          ok: false,
          status: 'unhealthy',
          database: 'error',
          error: error.message,
        },
        { status: 503 },
      )
    }

    return NextResponse.json(
      {
        ok: true,
        status: 'healthy',
        database: 'connected',
        migrationHead,
        timestamp: new Date().toISOString(),
      },
      { status: 200 },
    )
  } catch (error) {
    console.error('Health check threw:', error)

    return NextResponse.json(
      {
        ok: false,
        status: 'unhealthy',
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 503 },
    )
  }
}
