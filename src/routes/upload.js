import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  filebaseBucket,
  isFilebaseConfigured,
  isSupabaseConfigured,
  s3,
  supabase,
} from '../config.js';

const router = Router();
const upload = multer({ dest: path.join('/tmp', 'life-changer-uploads') });
const parseMedia = (req, res, next) => {
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
  ])(req, res, (error) => {
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    next();
  });
};

function makeObjectKey(userId, file) {
  const extension = path.extname(file.originalname).replace(/[^.a-zA-Z0-9]/g, '');
  return `${userId}/${randomUUID()}${extension}`;
}

async function storeMedia(userId, file) {
  const key = makeObjectKey(userId, file);

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: filebaseBucket,
        Key: key,
        Body: createReadStream(file.path),
        ContentLength: file.size,
        ContentType: file.mimetype || 'application/octet-stream',
      }),
    );

    let cid;
    try {
      const metadata = await s3.send(
        new HeadObjectCommand({ Bucket: filebaseBucket, Key: key }),
      );
      cid = metadata.Metadata?.cid;
    } catch {
      cid = undefined;
    }

    const reference = cid
      ? new URL(`https://ipfs.filebase.io/ipfs/${encodeURIComponent(cid)}`)
      : new URL(`https://s3.filebase.com/${encodeURIComponent(filebaseBucket)}/${key
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`);
    reference.searchParams.set('objectKey', key);
    return reference.toString();
  } finally {
    await unlink(file.path).catch(() => {});
  }
}

router.post('/', parseMedia, async (req, res) => {
  const { userId, caption, category } = req.body;
  const video = req.files?.video?.[0];
  const audio = req.files?.audio?.[0];

  if (!userId || !caption || !category || !video) {
    await Promise.all([video, audio].filter(Boolean).map((file) => unlink(file.path).catch(() => {})));
    return res.status(400).json({
      error: 'userId, caption, category, and video are required.',
    });
  }

  if (!isSupabaseConfigured || !isFilebaseConfigured) {
    await Promise.all([video, audio].filter(Boolean).map((file) => unlink(file.path).catch(() => {})));
    return res.status(503).json({ error: 'Supabase and Filebase credentials must be configured.' });
  }

  try {
    const [mediaUrl, audioUrl] = await Promise.all([
      storeMedia(userId, video),
      audio ? storeMedia(userId, audio) : null,
    ]);

    const { data, error } = await supabase
      .from('posts')
      .insert({
        user_id: userId,
        caption,
        category,
        media_url: mediaUrl,
        audio_url: audioUrl,
      })
      .select('id')
      .single();

    if (error) {
      return res.status(502).json({ error: 'Could not save the post.', details: error.message });
    }

    return res.status(201).json({ post_id: data.id });
  } catch (error) {
    console.error('Upload failed:', error);
    return res.status(500).json({ error: 'Upload failed.' });
  } finally {
    await Promise.all([video, audio].filter(Boolean).map((file) => unlink(file.path).catch(() => {})));
  }
});

export default router;