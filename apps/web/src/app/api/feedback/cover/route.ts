import { randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import sharp from 'sharp'

import { createServerClient } from '@fydio/supabase/server'

import { feedbackBucket } from '@/lib/env'
import { requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // 5 MB
const MAX_OUTPUT_BYTES = 400 * 1024 // 400 KB
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
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Images must be 5 MB or smaller.' }, { status: 413 })
  }
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'Use a JPEG, PNG or WebP image.' }, { status: 415 })
  }

  const input = Buffer.from(await file.arrayBuffer())

  let encoded: Buffer
  try {
    encoded = await reencode(input)
    if (encoded.byteLength > MAX_OUTPUT_BYTES) {
      encoded = await sharp(encoded, { limitInputPixels: MAX_INPUT_PIXELS })
        .webp({ quality: WEBP_FALLBACK_QUALITY })
        .toBuffer()
    }
    if (encoded.byteLength > MAX_OUTPUT_BYTES) {
      return NextResponse.json(
        { error: 'That image is too detailed to fit within 400 KB. Try a smaller one.' },
        { status: 413 },
      )
    }
  } catch (error) {
    console.error('[fydio] feedback image decode failed', {
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
    .from(feedbackBucket())
    .upload(path, encoded, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' })

  if (uploadError) {
    console.error('[fydio] feedback image upload failed', { userId, message: uploadError.message })
    return NextResponse.json(
      { error: 'Could not save that image. Please try again.' },
      { status: 500 },
    )
  }

  const publicUrl = supabase.storage.from(feedbackBucket()).getPublicUrl(path).data.publicUrl

  return NextResponse.json({
    ok: true,
    imagePath: path,
    imageUrl: publicUrl,
    bytes: encoded.byteLength,
  })
}

async function reencode(input: Buffer): Promise<Buffer> {
  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height) throw new Error('Image has no readable dimensions')

  // Auto-rotate by EXIF and strip EXIF metadata for privacy
  return image
    .rotate()
    .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
}
