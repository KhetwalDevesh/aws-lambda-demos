import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});
const EXPIRES_IN = 300; // seconds

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// GET /upload-url?filename=cat.jpg&contentType=image/jpeg
export const handler = async (event) => {
  const { filename, contentType = 'application/octet-stream' } = event.queryStringParameters ?? {};
  if (!filename) return json(400, { error: 'filename query param is required' });

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `uploads/${randomUUID()}-${safeName}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: process.env.BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: EXPIRES_IN },
  );

  return json(200, {
    uploadUrl,
    key,
    expiresInSeconds: EXPIRES_IN,
    note: `PUT the file to uploadUrl with header Content-Type: ${contentType}`,
  });
};
