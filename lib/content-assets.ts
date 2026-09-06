import { assert, id, now } from './core';
import { env, one, stmt } from './server';

function bucket(): R2Bucket {
  assert(env.CONFIGS, '图片存储尚未接入', 503);
  return env.CONFIGS;
}

export async function saveArticleImage(dataUrl: unknown) {
  assert(typeof dataUrl === 'string', '图片无效');
  const match = dataUrl.match(
    /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/,
  );
  assert(match, '仅支持 PNG、JPEG、GIF 或 WebP 图片');
  const raw = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
  assert(
    raw.byteLength > 0 && raw.byteLength <= 3 * 1024 * 1024,
    '图片不能超过 3 MB',
  );
  const assetId = id(),
    key = `content/${assetId}`;
  await bucket().put(key, raw, { httpMetadata: { contentType: match[1] } });
  await stmt(
    'INSERT INTO content_assets(id,object_key,content_type,size,created_at) VALUES(?,?,?,?,?)',
    assetId,
    key,
    match[1],
    raw.byteLength,
    now(),
  ).run();
  return { url: `/api/content/image/${assetId}` };
}

export async function getArticleImage(assetId: string) {
  const item = await one('SELECT * FROM content_assets WHERE id=?', assetId);
  assert(item, '图片不存在', 404);
  const object = await bucket().get(item.object_key);
  assert(object, '图片文件不存在', 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': item.content_type,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
