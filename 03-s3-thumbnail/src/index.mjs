import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const s3 = new S3Client({});
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|tiff?)$/i;

export const handler = async (event) => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    // S3 keys in events are URL-encoded, with spaces as '+'
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    if (!IMAGE_EXT.test(key)) {
      console.log(`skip non-image: ${key}`);
      continue;
    }

    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const input = Buffer.from(await Body.transformToByteArray());

    const output = await sharp(input)
      .rotate()
      .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const thumbKey = `thumbs/${key.replace(/\.[^.]+$/, '')}.webp`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.THUMB_BUCKET,
        Key: thumbKey,
        Body: output,
        ContentType: 'image/webp',
      }),
    );
    console.log(`thumbnail ${bucket}/${key} (${input.length}B) -> ${thumbKey} (${output.length}B)`);
  }
};
