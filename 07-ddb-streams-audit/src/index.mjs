import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TTL_SECONDS = 24 * 60 * 60;

const diff = (before = {}, after = {}) => {
  const changed = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      changed[k] = { from: before[k] ?? null, to: after[k] ?? null };
    }
  }
  return changed;
};

export const handler = async (event) => {
  for (const record of event.Records) {
    const { Keys, OldImage, NewImage, ApproximateCreationDateTime } = record.dynamodb;
    const before = OldImage ? unmarshall(OldImage) : undefined;
    const after = NewImage ? unmarshall(NewImage) : undefined;
    const itemId = unmarshall(Keys).id;
    const when = new Date((ApproximateCreationDateTime ?? Date.now() / 1000) * 1000).toISOString();

    const entry = {
      itemId,
      // Sort key: time first so history reads in order, eventID makes it unique
      changeId: `${when}#${record.eventID}`,
      action: record.eventName, // INSERT | MODIFY | REMOVE
      changes: record.eventName === 'MODIFY' ? diff(before, after) : undefined,
      before,
      after,
      expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    };

    await db.send(
      new PutCommand({
        TableName: process.env.AUDIT_TABLE,
        Item: entry,
        // Stream records can be delivered more than once; never write the same change twice
        ConditionExpression: 'attribute_not_exists(itemId)',
      }),
    ).catch((err) => {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
      console.log(`duplicate delivery ignored: ${entry.changeId}`);
    });

    console.log(`audit ${record.eventName} id=${itemId}`);
  }
};
