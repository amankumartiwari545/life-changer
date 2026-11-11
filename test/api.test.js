import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

process.env.SUPABASE_URL = 'https://mock-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
process.env.FILEBASE_ACCESS_KEY = 'mock-filebase-access-key';
process.env.FILEBASE_SECRET_KEY = 'mock-filebase-secret-key';
process.env.FILEBASE_BUCKET_NAME = 'mock-media';

let server;
let baseUrl;
let supabase;
let s3;

before(async () => {
  const [{ default: app }, config] = await Promise.all([
    import('../src/server.js'),
    import('../src/config.js'),
  ]);
  supabase = config.supabase;
  s3 = config.s3;
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function makeQuery(result) {
  return {
    select() {
      return this;
    },
    not() {
      return this;
    },
    limit() {
      return Promise.resolve(result);
    },
    eq() {
      return Promise.resolve(result);
    },
  };
}

function mockFeedData(t, { error = null } = {}) {
  const posts = [
    {
      id: 'preferred-post',
      user_id: 'creator-1',
      caption: 'Mock video',
      category: 'music',
      media_url: 'https://ipfs.filebase.io/ipfs/mock-cid?objectKey=creator-1%2Fvideo.mp4',
      audio_url: 'https://ipfs.filebase.io/ipfs/mock-audio?objectKey=creator-1%2Faudio.mp3',
      likes_count: 12,
      saves_count: 4,
      created_at: new Date().toISOString(),
      profiles: { username: 'mock-creator' },
    },
    {
      id: 'other-category-post',
      user_id: 'creator-2',
      caption: 'Other category',
      category: 'sports',
      media_url: 'https://ipfs.filebase.io/ipfs/other-cid?objectKey=creator-2%2Fvideo.mp4',
      audio_url: null,
      likes_count: 1,
      saves_count: 0,
      created_at: new Date().toISOString(),
      profiles: { username: 'other-creator' },
    },
  ];

  t.mock.method(supabase, 'from', (table) => {
    if (table === 'posts') {
      return makeQuery({ data: posts, error });
    }
    if (table === 'likes') {
      return makeQuery({ data: [{ post_id: 'preferred-post' }], error: null });
    }
    if (table === 'saves') {
      return makeQuery({ data: [], error: null });
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

function mockUploadData(t, { error = null } = {}) {
  let insertedPost;
  t.mock.method(supabase, 'from', (table) => {
    assert.equal(table, 'posts');
    return {
      insert(values) {
        insertedPost = values;
        return {
          select() {
            return this;
          },
          single() {
            return Promise.resolve({ data: { id: 'mock-post-id' }, error });
          },
        };
      },
    };
  });
  return () => insertedPost;
}

function mockObjectStorage(t, { fail = false } = {}) {
  const uploadedKeys = [];
  t.mock.method(s3, 'send', async (command) => {
    if (fail) {
      throw new Error('mock object storage failure');
    }
    if (command.constructor.name === 'PutObjectCommand') {
      uploadedKeys.push(command.input.Key);
    }
    if (command.constructor.name === 'HeadObjectCommand') {
      return { Metadata: { cid: 'mock-cid' } };
    }
    return {};
  });
  return uploadedKeys;
}

async function uploadRequest({ includeAudio = true } = {}) {
  const form = new FormData();
  form.set('userId', 'mock-user-id');
  form.set('caption', 'A mock upload');
  form.set('category', 'music');
  form.set('video', new Blob(['mock video bytes'], { type: 'video/mp4' }), 'video.mp4');
  if (includeAudio) {
    form.set('audio', new Blob(['mock audio bytes'], { type: 'audio/mpeg' }), 'audio.mp3');
  }
  return fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
}

test('imports routes and rejects a feed request without userId', async () => {
  const response = await fetch(`${baseUrl}/api/feed`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'userId is required.' });
});

test('feed ranks mock posts, filters by interaction category, and signs playback URLs', async (t) => {
  mockFeedData(t);
  const response = await fetch(`${baseUrl}/api/feed?userId=mock-user-id`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.posts.length, 1);
  assert.equal(body.posts[0].id, 'preferred-post');
  assert.match(body.posts[0].media_url, /X-Amz-Expires=900/);
  assert.match(body.posts[0].audio_url, /X-Amz-Expires=900/);
  assert.equal(body.posts[0].permanent_media_url.includes('mock-cid'), true);
});

test('feed returns a handled database error instead of crashing', async (t) => {
  mockFeedData(t, { error: { message: 'mock database failure' } });
  const response = await fetch(`${baseUrl}/api/feed?userId=mock-user-id`);
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.details, 'mock database failure');
});

test('upload rejects a request without multipart media', async () => {
  const response = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  assert.equal(response.status, 400);
});

test('upload stores mock files and returns the generated post id', async (t) => {
  const getInsertedPost = mockUploadData(t);
  mockObjectStorage(t);
  const response = await uploadRequest();
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(body, { post_id: 'mock-post-id' });
  assert.equal(getInsertedPost().user_id, 'mock-user-id');
  assert.match(getInsertedPost().media_url, /mock-cid/);
  assert.match(getInsertedPost().audio_url, /mock-cid/);
});

test('upload accepts a video without audio and stores a null audio_url', async (t) => {
  const getInsertedPost = mockUploadData(t);
  const uploadedKeys = mockObjectStorage(t);
  const response = await uploadRequest({ includeAudio: false });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(body, { post_id: 'mock-post-id' });
  assert.equal(getInsertedPost().audio_url, null);
  assert.equal(uploadedKeys.length, 1);
});

test('upload returns a handled database error instead of crashing', async (t) => {
  mockUploadData(t, { error: { message: 'mock insert failure' } });
  mockObjectStorage(t);
  const response = await uploadRequest();
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.details, 'mock insert failure');
});

test('upload returns a handled storage error instead of crashing', async (t) => {
  mockUploadData(t);
  mockObjectStorage(t, { fail: true });
  t.mock.method(console, 'error', () => {});
  const response = await uploadRequest();
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error, 'Upload failed.');
});