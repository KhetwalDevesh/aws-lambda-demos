import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

// Created outside the handler so warm invocations reuse the connection
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TableName = process.env.TABLE_NAME;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const { method } = event.requestContext.http;
  const id = event.pathParameters?.id;

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }

  // POST /items
  if (method === 'POST' && !id) {
    if (!body.title) return json(400, { error: 'title is required' });
    const item = {
      id: randomUUID(),
      title: body.title,
      done: false,
      createdAt: new Date().toISOString(),
    };
    await db.send(new PutCommand({ TableName, Item: item }));
    return json(201, item);
  }

  // GET /items
  if (method === 'GET' && !id) {
    const { Items } = await db.send(new ScanCommand({ TableName, Limit: 100 }));
    return json(200, Items);
  }

  // GET /items/{id}
  if (method === 'GET' && id) {
    const { Item } = await db.send(new GetCommand({ TableName, Key: { id } }));
    return Item ? json(200, Item) : json(404, { error: 'not found' });
  }

  // PUT /items/{id}
  if (method === 'PUT' && id) {
    const sets = ['#u = :u'];
    const names = { '#u': 'updatedAt' };
    const values = { ':u': new Date().toISOString() };
    for (const k of ['title', 'done']) {
      if (k in body) {
        sets.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = body[k];
      }
    }
    if (sets.length === 1) return json(400, { error: 'send title and/or done' });
    try {
      const { Attributes } = await db.send(
        new UpdateCommand({
          TableName,
          Key: { id },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(id)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return json(200, Attributes);
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') return json(404, { error: 'not found' });
      throw err;
    }
  }

  // DELETE /items/{id}
  if (method === 'DELETE' && id) {
    await db.send(new DeleteCommand({ TableName, Key: { id } }));
    return { statusCode: 204 };
  }

  return json(405, { error: 'method not allowed' });
};
