import { randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import sharp from 'sharp'

import {
  COVER_MIME_TYPES,
  COVER_OUTPUT_HEIGHT,
  COVER_OUTPUT_WIDTH,
  MAX_COVER_OUTPUT_BYTES,
  MAX_COVER_UPLOAD_BYTES,
} from '@fydio/domain'
import { createServerClient } from '@fydio/supabase/server'

import { coversBucket } from '@/lib/env'
import { requireUserId } from '@/lib/server'

/**
 * Cover image upload (T04).
 *
 * Same shape as POST /api/profile/avatar: validate the declaration, decode
 * with sharp (which proves the bytes are a real image), re-encode to a
 * 1200x630 WebP under 300 KB, store under `{user_id}/{timestamp}.webp`.
 *
 * Covers are uploaded BEFORE the entry exists (the form needs a preview), so
 * the path is returned to the client and passed as `coverPath` to
 * POST /api/entries. A failed upload never costs a credit because the spend
 * happens in `create_content_entry`, after the cover already exists.
 */
export const dynamic = 'force-dynamic'

const WEBP_QUALITY = 80
const WEBP_FALLBACK_QUALITY = 60
const MAX_INPUT_PIXELS = 100_000_000

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await requireUserId()

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Expected a multipart form.' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was uploaded.' }, { status: 400 })
  }

  if (file.size === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 })
  }
  if (file.size > MAX_COVER_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Covers must be 5 MB or smaller.' }, { status: 413 })
  }
  if (!(COVER_MIME_TYPES as readonly string[]).includes(file.type)) {
    return NextResponse.json({ error: 'Use a JPEG, PNG or WebP image.' }, { status: 415 })
  }

  const input = Buffer.from(await file.arrayBuffer())

  let encoded: Buffer
  try {
    encoded = await reencode(input)
    if (encoded.byteLength > MAX_COVER_OUTPUT_BYTES) {
      encoded = await sharp(encoded, { limitInputPixels: MAX_INPUT_PIXELS })
        .webp({ quality: WEBP_FALLBACK_QUALITY })
        .toBuffer()
    }
    if (encoded.byteLength > MAX_COVER_OUTPUT_BYTES) {
      return NextResponse.json(
        { error: 'That image is too detailed to fit in a cover. Try a smaller one.' },
        { status: 413 },
      )
    }
    // Minimum-dimension guard AFTER decode: a 1x1 file passes MIME/size but is
    // not a usable cover.
    const meta = await sharp(encoded).metadata()
    if (!meta.width || !meta.height || meta.width < 400 || meta.height < 225) {
      return NextResponse.json({ error: 'Covers must be at least 400×225 pixels.' }, { status: 400 })
    }
  } catch (error) {
    console.error('[fydio] cover decode failed', {
      userId,
      message: error instanceof Error ? error.message : 'unknown error',
    })
    return NextResponse.json({ error: 'That file could not be read as an image.' }, { status: 415 })
  }

  const jar = await cookies()
  const supabase = createServerClient({
    getAll() {
      return jar.getAll()
    },
    set(name, value, options) {
      jar.set(name, value, options ?? {})
    },
  })

  const path = `${userId}/${Date.now()}-${randomUUID().split('-')[0]}.webp`
  const { error: uploadError } = await supabase.storage
    .from(coversBucket())
    .upload(path, encoded, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' })

  if (uploadError) {
    console.error('[fydio] cover upload failed', { userId, message: uploadError.message })
    return NextResponse.json({ error: 'Could not save that cover. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    coverPath: path,
    coverUrl: supabase.storage.from(coversBucket()).getPublicUrl(path).data.publicUrl,
    bytes: encoded.byteLength,
  })
}

async function reencode(input: Buffer): Promise<Buffer> {
  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height) throw new Error('Image has no readable dimensions')
  return image
    .rotate()
    .resize(COVER_OUTPUT_WIDTH, COVER_OUTPUT_HEIGHT, { fit: 'cover' })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
}
