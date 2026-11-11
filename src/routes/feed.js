import { Router } from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  filebaseBucket,
  isFilebaseConfigured,
  isSupabaseConfigured,
  s3,
  supabase,
} from '../config.js';

const router = Router();
const SIGNED_URL_TTL_SECONDS = 900;

async function getPreferredCategory(userId, posts) {
  const [likesResult, savesResult] = await Promise.all([
    supabase.from('likes').select('post_id').eq('user_id', userId),
    supabase.from('saves').select('post_id').eq('user_id', userId),
  ]);
  const interactedPostIds = new Set(
    [...(likesResult.data || []), ...(savesResult.data || [])]
      .map((interaction) => interaction.post_id)
      .filter(Boolean),
  );
  const counts = new Map();

  for (const post of posts) {
    if (interactedPostIds.has(post.id) && post.category) {
      counts.set(post.category, (counts.get(post.category) || 0) + 1);
    }
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

function objectKeyFromReference(reference) {
  const url = new URL(reference);
  const objectKey = url.searchParams.get('objectKey');
  if (!objectKey) {
    throw new Error('Stored media reference does not contain an object key.');
  }
  return objectKey;
}

async function makePlaybackUrl(reference) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: filebaseBucket,
      Key: objectKeyFromReference(reference),
    }),
    { expiresIn: SIGNED_URL_TTL_SECONDS },
  );
}

function rankScore(post) {
  const ageHours = Math.max(0, (Date.now() - new Date(post.created_at).getTime()) / 3_600_000);
  const freshness = Math.exp(-ageHours / 72);
  return (
    0.5 * Math.log1p(Number(post.likes_count) || 0) +
    0.3 * Math.log1p(Number(post.saves_count) || 0) +
    0.2 * freshness
  );
}

router.get('/', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required.' });
  }
  if (!isSupabaseConfigured || !isFilebaseConfigured) {
    return res.status(503).json({ error: 'Supabase and Filebase credentials must be configured.' });
  }

  try {
    const { data: posts, error } = await supabase
      .from('posts')
      .select('id,user_id,caption,category,media_url,audio_url,likes_count,saves_count,created_at,profiles(*)')
      .not('media_url', 'is', null)
      .limit(200);

    if (error) {
      return res.status(502).json({ error: 'Could not load the feed.', details: error.message });
    }

    const preferredCategory = await getPreferredCategory(userId, posts || []);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 50);
    const rankedPosts = (posts || [])
      .filter((post) => !preferredCategory || post.category === preferredCategory)
      .sort((left, right) => rankScore(right) - rankScore(left))
      .slice(0, limit);

    const feed = await Promise.all(
      rankedPosts.map(async (post) => ({
        ...post,
        permanent_media_url: post.media_url,
        permanent_audio_url: post.audio_url,
        media_url: await makePlaybackUrl(post.media_url),
        audio_url: post.audio_url ? await makePlaybackUrl(post.audio_url) : null,
      })),
    );

    return res.json({ posts: feed });
  } catch (error) {
    console.error('Feed request failed:', error);
    return res.status(500).json({ error: 'Could not generate the feed.' });
  }
});

export default router;