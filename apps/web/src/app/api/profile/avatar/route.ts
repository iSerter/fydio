import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import sharp from 'sharp'

import {
  AVATAR_OUTPUT_SIZE,
  MAX_AVATAR_OUTPUT_BYTES,
  MAX_AVATAR_UPLOAD_BYTES,
} from '@fydio/domain'
import { createServerClient } from '@fydio/supabase/server'

import { avatarBucket } from '@/lib/env'
import { requireUserId } from '@/lib/server'

/**
 * Avatar upload (T03).
 *
 * WHY THE CLIENT NEVER UPLOADS TO STORAGE DIRECTLY. Two reasons, and the second is the one
 * that matters:
 *
 *   1. Size and type validation would be trivially bypassable by anyone calling the Storage
 *      API instead of the app.
 *   2. More importantly, the upload must be RE-ENCODED. A file that passes a MIME check can
 *      still be a decompression bomb dressed as a small JPEG. Only a decoder that processes
 *      the pixels proves what the file is -- and sharp fails on anything that is not a real
 *      image, which is the check a declared type cannot be.
 *
 * So the flow is: bytes in, validate the declaration, decode with sharp, re-encode to a
 * 512x512 WebP under 200 KB, upload, delete the previous object, write the path.
 */
export const dynamic = 'force-dynamic'

/** WebP quality, chosen so the output lands under 200 KB for a 512x512 crop. */
const WEBP_QUALITY = 82

/**
 * Cap on pixels sharp will decode.
 *
 * Without this, a 30000x30000 PNG of 3 KB would pass the byte-size check and then try to
 * allocate ~3.6 GB. The limit is ~100 megapixels, far beyond any real avatar, and it is the
 * defence that makes the byte-size check meaningful rather than decorative.
 */
const MAX_INPUT_PIXELS = 100_000_000

/** The declaration check, mirroring `AVATAR_MIME_TYPES` in the domain package. */
const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']

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

  // Size is checked BEFORE reading the bytes, so a 6 MB upload costs nothing but the
  // multipart parse rather than a buffer allocation.
  if (file.size === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 })
  }

  if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Images must be 5 MB or smaller.' }, { status: 413 })
  }

  if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'Use a JPEG, PNG or WebP image.' }, { status: 415 })
  }

  const input = Buffer.from(await file.arrayBuffer())

  let encoded: Buffer

  try {
    encoded = await reencode(input)
  } catch (error) {
    // A declared JPEG that sharp cannot decode is exactly the case the MIME check cannot
    // catch. Reported as an unusable image rather than a 500, because from the member's point
    // of view that IS what it is.
    console.error('[fydio] avatar decode failed', {
      userId,
      message: error instanceof Error ? error.message : 'unknown error',
    })

    return NextResponse.json({ error: 'That file could not be read as an image.' }, { status: 415 })
  }

  // Belt-and-braces: if a 512x512 WebP still exceeds the ceiling, re-encode harder. This should
  // not trigger for any sane input, but "should not" is not a guarantee about a file someone
  // else uploaded.
  if (encoded.byteLength > MAX_AVATAR_OUTPUT_BYTES) {
    encoded = await sharp(encoded, { limitInputPixels: MAX_INPUT_PIXELS })
      .webp({ quality: 60 })
      .toBuffer()
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

  // The previous object is read now but deleted only AFTER a successful replace. Deleting
  // first would leave a member with no avatar if the upload then failed.
  const { data: existing } = await supabase
    .from('profiles')
    .select('avatar_path')
    .eq('id', userId)
    .maybeSingle()

  const previousPath = existing?.avatar_path ?? null

  // `{user_id}/{timestamp}.webp`. The user id as the first path segment is what makes the
  // storage RLS policy an ownership test rather than a naming convention.
  const path = `${userId}/${Date.now()}.webp`

  const { error: uploadError } = await supabase.storage
    .from(avatarBucket())
    .upload(path, encoded, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' })

  if (uploadError) {
    console.error('[fydio] avatar upload failed', { userId, message: uploadError.message })

    return NextResponse.json(
      { error: 'Could not save your avatar. Please try again.' },
      { status: 500 },
    )
  }

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ avatar_path: path })
    .eq('id', userId)

  if (updateError) {
    // The object is now orphaned. Removing it here rather than leaving it keeps Storage from
    // accumulating images no profile points at.
    await supabase.storage.from(avatarBucket()).remove([path])

    return NextResponse.json(
      { error: 'Could not save your avatar. Please try again.' },
      { status: 500 },
    )
  }

  if (previousPath !== null && previousPath !== path) {
    // Failure here is not worth failing the request over: the new avatar is already saved and
    // visible, and a stale object costs a few kilobytes until the bucket is swept.
    await supabase.storage.from(avatarBucket()).remove([previousPath])
  }

  return NextResponse.json({
    ok: true,
    avatarPath: path,
    // Public read, so this URL can be used directly in an <img> without signing.
    avatarUrl: supabase.storage.from(avatarBucket()).getPublicUrl(path).data.publicUrl,
    bytes: encoded.byteLength,
  })
}

/**
 * Decode, crop and re-encode an avatar.
 *
 * `rotate()` with no argument applies the EXIF orientation first. Without it, a photo taken in
 * portrait on a phone arrives rotated 90 degrees -- and since the source of most avatars is
 * exactly a phone camera, that is the common case rather than the rare one.
 *
 * `fit: 'cover'` with no `position` defaults to a centre crop, which is what an avatar wants: a
 * square thumbnail that is not distorted, trimming the least interesting edges instead of
 * squashing the face.
 */
async function reencode(input: Buffer): Promise<Buffer> {
  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
  const metadata = await image.metadata()

  // A zero dimension means the header parsed but described no real image. `sharp` throws on
  // most malformed input already; this catches the ones that decode to nothing.
  if (!metadata.width || !metadata.height) {
    throw new Error('Image has no readable dimensions')
  }

  return image
    .rotate()
    .resize(AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE, { fit: 'cover' })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer()
}