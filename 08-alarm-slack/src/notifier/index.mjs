import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
let webhookUrl; // cached across warm invocations

const getWebhook = async () => {
  if (webhookUrl !== undefined) return webhookUrl;
  try {
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: process.env.WEBHOOK_PARAM, WithDecryption: true }),
    );
    webhookUrl = Parameter.Value;
  } catch (err) {
    if (err.name !== 'ParameterNotFound') throw err;
    webhookUrl = null;
  }
  return webhookUrl;
};

export const handler = async (event) => {
  for (const record of event.Records) {
    const alarm = JSON.parse(record.Sns.Message);
    const emoji = alarm.NewStateValue === 'ALARM' ? ':rotating_light:' : ':white_check_mark:';
    const text =
      `${emoji} *${alarm.AlarmName}* is *${alarm.NewStateValue}*\n` +
      `${alarm.AlarmDescription ?? ''}\n` +
      `Reason: ${alarm.NewStateReason}\n` +
      `Region: ${alarm.Region}`;

    const url = await getWebhook();
    if (!url) {
      console.log(`[dry-run] no Slack webhook at ${process.env.WEBHOOK_PARAM}. Would post:\n${text}`);
      continue;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack responded ${res.status}: ${await res.text()}`);
    console.log(`posted to Slack: ${alarm.AlarmName} ${alarm.NewStateValue}`);
  }
};
