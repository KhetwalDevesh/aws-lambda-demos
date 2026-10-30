import { createHmac, timingSafeEqual } from 'node:crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
const cache = {};

const getSecret = async (name) => {
  if (name in cache) return cache[name];
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: `${process.env.SECRET_PREFIX}/${name}`, WithDecryption: true }),
    );
    cache[name] = Parameter.Value;
  } catch (err) {
    if (err.name !== 'ParameterNotFound') throw err;
    cache[name] = null;
  }
  return cache[name];
};

const reply = (statusCode, message) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message }),
});

const validSignature = (secret, rawBody, header = '') => {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const handler = async (event) => {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
  const headers = event.headers ?? {}; // Function URL lowercases header names

  const secret = await getSecret('webhook-secret');
  if (!secret) return reply(500, 'webhook-secret not configured in SSM');
  if (!validSignature(secret, rawBody, headers['x-hub-signature-256'])) {
    console.warn('rejected: bad signature');
    return reply(401, 'invalid signature');
  }

  const ghEvent = headers['x-github-event'];
  if (ghEvent === 'ping') return reply(200, 'pong');
  if (ghEvent !== 'push') return reply(202, `ignored event: ${ghEvent}`);

  const payload = JSON.parse(rawBody);
  const branch = process.env.DEPLOY_BRANCH;
  if (payload.ref !== `refs/heads/${branch}`) {
    return reply(202, `ignored push to ${payload.ref}`);
  }

  const sha = payload.after?.slice(0, 7);
  const token = await getSecret('token');
  if (!token) {
    console.log(`[dry-run] would dispatch ${process.env.WORKFLOW_FILE} for ${sha} (no token in SSM)`);
    return reply(200, 'dry-run: deploy not dispatched');
  }

  const res = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/workflows/${process.env.WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'lambda-demo-webhook',
      },
      body: JSON.stringify({ ref: branch, inputs: { sha: payload.after ?? '' } }),
    },
  );
  if (res.status !== 204) {
    console.error(`dispatch failed ${res.status}: ${await res.text()}`);
    return reply(502, `GitHub dispatch failed with ${res.status}`);
  }
  console.log(`deploy dispatched for ${sha}`);
  return reply(200, `deploy dispatched for ${sha}`);
};
