import 'dotenv/config';
import { S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
    supabaseServiceRoleKey &&
    !supabaseUrl.startsWith('YOUR_') &&
    !supabaseServiceRoleKey.startsWith('YOUR_'),
);

export const supabase = createClient(
  isSupabaseConfigured ? supabaseUrl : 'https://placeholder.supabase.co',
  isSupabaseConfigured ? supabaseServiceRoleKey : 'placeholder-service-role-key',
);

export const filebaseBucket = process.env.FILEBASE_BUCKET_NAME;

export const isFilebaseConfigured = Boolean(
  process.env.FILEBASE_ACCESS_KEY &&
    process.env.FILEBASE_SECRET_KEY &&
    filebaseBucket &&
    !process.env.FILEBASE_ACCESS_KEY.startsWith('YOUR_') &&
    !process.env.FILEBASE_SECRET_KEY.startsWith('YOUR_') &&
    !filebaseBucket.startsWith('YOUR_'),
);

export const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: 'https://s3.filebase.com',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY || 'placeholder-access-key',
    secretAccessKey: process.env.FILEBASE_SECRET_KEY || 'placeholder-secret-key',
  },
});