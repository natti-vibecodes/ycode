import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-server';
import { createAsset } from '@/lib/repositories/assetRepository';
import { validateCategoryMimeType } from '@/lib/asset-utils';
import { validateStorableMimeType } from '@/lib/asset-mime-policy';
import { STORAGE_BUCKET, getDisplayName } from '@/lib/asset-constants';

export const runtime = 'nodejs';

/**
 * POST /ycode/api/files/register
 * Create an Asset database record after a direct browser-to-storage upload completes.
 * Pairs with the presign route for large file uploads.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { storagePath, filename, mimeType, fileSize, source, category, customName, assetFolderId } = body as {
      storagePath: string;
      filename: string;
      mimeType: string;
      fileSize: number;
      source: string;
      category?: string | null;
      customName?: string;
      assetFolderId?: string | null;
    };

    if (!storagePath || !filename || !mimeType || !fileSize || !source) {
      return NextResponse.json(
        { error: 'storagePath, filename, mimeType, fileSize, and source are required' },
        { status: 400 }
      );
    }

    // `mimeType` is client-supplied and is what `/a/{hash}/{name}` later echoes
    // back as Content-Type on the builder's own origin. Presigning this file
    // does not vouch for it: presign runs before the bytes exist, and a caller
    // can presign an SVG, PUT HTML into it, then register it under any type it
    // likes — or skip the client entirely and POST here directly.
    //
    // The allowlist check is unconditional because the category check below
    // cannot carry this weight: validateCategoryMimeType returns null whenever
    // `category` is null, and the file manager uploads with `category: null`.
    const mimeTypeError = validateStorableMimeType(mimeType);
    if (mimeTypeError) {
      return NextResponse.json({ error: mimeTypeError }, { status: 400 });
    }

    // Narrower check for callers that DO declare a category, matching what
    // presign and upload enforce so all three upload paths agree.
    const categoryError = validateCategoryMimeType(mimeType, category);
    if (categoryError) {
      return NextResponse.json({ error: categoryError }, { status: 400 });
    }

    const supabase = await getSupabaseAdmin();

    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    const asset = await createAsset({
      filename: getDisplayName(filename, customName),
      storage_path: storagePath,
      public_url: urlData.publicUrl,
      file_size: fileSize,
      mime_type: mimeType,
      source,
      asset_folder_id: assetFolderId,
    });

    return NextResponse.json({ data: asset }, { status: 200 });
  } catch (error) {
    console.error('Error registering asset:', error);
    return NextResponse.json({ error: 'Failed to register asset' }, { status: 500 });
  }
}
