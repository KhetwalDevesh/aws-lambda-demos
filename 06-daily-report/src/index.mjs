import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const lambda = new LambdaClient({});
const s3 = new S3Client({});
const ses = new SESv2Client({});

export const handler = async () => {
  const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
  const { Functions = [] } = await lambda.send(new ListFunctionsCommand({}));

  const today = new Date().toLocaleDateString('en-IN', { dateStyle: 'full', timeZone: 'Asia/Kolkata' });
  const lines = [
    `AWS daily report - ${today}`,
    '',
    `S3 buckets:       ${Buckets.length}`,
    `Lambda functions: ${Functions.length}`,
    '',
    ...Functions.slice(0, 20).map((f) => `  - ${f.FunctionName} (${f.Runtime}, ${f.MemorySize} MB)`),
  ];

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: process.env.SENDER,
      Destination: { ToAddresses: [process.env.RECIPIENT] },
      Content: {
        Simple: {
          Subject: { Data: `Daily AWS report - ${today}` },
          Body: { Text: { Data: lines.join('\n') } },
        },
      },
    }),
  );
  console.log(`report sent to ${process.env.RECIPIENT}`);
};
