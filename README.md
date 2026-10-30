# Serverless Playground - AWS Lambda demos

Nine small demos, each its own SAM stack (Node.js 22, arm64, region `ap-southeast-2`).
Deploy one, trigger it, record, delete it.

| # | Folder | Trigger | Shows |
|---|---|---|---|
| 01 | `01-crud-api` | HTTP | API Gateway + Lambda + DynamoDB CRUD |
| 02 | `02-presigned-upload` | HTTP | Presigned S3 URL, client uploads direct to S3 |
| 03 | `03-s3-thumbnail` | S3 event | Upload -> resize with sharp -> second bucket |
| 04 | `04-sqs-worker-dlq` | SQS | Batching, partial failures, dead-letter queue |
| 05 | `05-sns-fanout` | SNS | One publish -> Lambda + SQS->Lambda (+ email) |
| 06 | `06-daily-report` | Schedule | EventBridge Scheduler 09:00 IST -> SES email |
| 07 | `07-ddb-streams-audit` | DDB Stream | Change data capture into an audit table |
| 08 | `08-alarm-slack` | CloudWatch alarm | Alarm -> SNS -> Lambda -> Slack |
| 09 | `09-github-webhook-deploy` | Function URL | Verify HMAC, dispatch GitHub Actions deploy |

## One-time setup

```bash
brew install aws-sam-cli          # Docker is already installed
aws configure                     # or: aws configure sso
aws sts get-caller-identity       # must print your account
```

Set a budget alarm first (alerts at $1):

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws budgets create-budget --account-id $ACCOUNT \
  --budget '{"BudgetName":"lambda-demo","BudgetLimit":{"Amount":"1","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"YOUR_EMAIL"}]}]'
```

## Workflow

```bash
make deploy D=01-crud-api     # sam build + sam deploy
make logs   D=01-crud-api     # tail CloudWatch logs (second terminal while recording)
make delete D=01-crud-api     # tear down
make delete-all               # tear down every demo
```

`sam deploy` prints the stack Outputs (URLs, bucket names, queue URLs) used below.
Fetch them again any time:

```bash
aws cloudformation describe-stacks --stack-name lambda-demo-01-crud-api \
  --region ap-southeast-2 --query 'Stacks[0].Outputs'
```

All commands below assume these are set in your shell:

```bash
export AWS_PROFILE=personal AWS_REGION=ap-southeast-2
```

---

## 01 - CRUD API

```bash
API=<ApiUrl output>
curl -s -X POST $API -H 'content-type: application/json' -d '{"title":"learn lambda"}'
curl -s $API
ID=<id from the POST>
curl -s -X PUT $API/$ID -H 'content-type: application/json' -d '{"done":true}'
curl -s $API/$ID
curl -s -X DELETE $API/$ID -i
```

## 02 - Presigned upload

```bash
API=<ApiUrl output>
RES=$(curl -s "$API?filename=cat.jpg&contentType=image/jpeg")
URL=$(echo $RES | python3 -c 'import sys,json;print(json.load(sys.stdin)["uploadUrl"])')
curl -X PUT "$URL" -H 'content-type: image/jpeg' --data-binary @cat.jpg
aws s3 ls s3://<BucketName output>/uploads/
```

## 03 - S3 thumbnail

Deploy with Docker running (the Makefile adds `--use-container` for sharp).

```bash
aws s3 cp photo.jpg s3://<SourceBucketName output>/
sleep 5
aws s3 ls s3://<ThumbBucketName output>/thumbs/
```

## 04 - SQS worker + DLQ

```bash
Q=<JobsQueueUrl output>
aws sqs send-message --queue-url $Q --message-body "hello"
aws sqs send-message --queue-url $Q --message-body "please fail"   # retried 3x -> DLQ
make logs D=04-sqs-worker-dlq
# after ~3 minutes (3 receives x 60s visibility timeout):
aws sqs receive-message --queue-url <DeadLetterQueueUrl output>
```

## 05 - SNS fan-out

```bash
aws sns publish --topic-arn <TopicArn output> --subject "New order" \
  --message '{"orderId":42,"total":999}'
make logs D=05-sns-fanout       # both [direct] and [buffered] lines appear
```

Optional email: set `DEMO_EMAIL` in `.env` (see `.env.example`) and confirm the email AWS sends.

## 06 - Daily report

SES starts in sandbox, so verify both addresses first and click the links:

```bash
aws sesv2 create-email-identity --email-identity you@example.com
```

Put the address in `.env` as `DEMO_EMAIL` (see `.env.example`), deploy, then trigger on demand
(no need to wait for 09:00):

```bash
aws lambda invoke --function-name lambda-demo-06-daily-report-report out.json && cat out.json
```

The schedule itself is visible in the console under EventBridge -> Scheduler.

## 07 - DynamoDB Streams audit

```bash
T=<CustomersTableName output>
aws dynamodb put-item --table-name $T --item '{"id":{"S":"c1"},"name":{"S":"Asha"},"plan":{"S":"free"}}'
aws dynamodb update-item --table-name $T --key '{"id":{"S":"c1"}}' \
  --update-expression 'SET #p = :p' --expression-attribute-names '{"#p":"plan"}' \
  --expression-attribute-values '{":p":{"S":"pro"}}'
aws dynamodb delete-item --table-name $T --key '{"id":{"S":"c1"}}'
sleep 5
aws dynamodb query --table-name <AuditTableName output> \
  --key-condition-expression 'itemId = :i' --expression-attribute-values '{":i":{"S":"c1"}}'
```

You should see INSERT, MODIFY (with `plan: free -> pro`) and REMOVE.

Wait about a minute after deploying before the first write. With `StartingPosition: LATEST`, changes made before the stream connection is live are not delivered.

## 08 - Alarm to Slack

1. Create a Slack incoming webhook (api.slack.com/messaging/webhooks).
2. Store it:
   ```bash
   aws ssm put-parameter --name /lambda-demo/slack-webhook --type SecureString \
     --value 'https://hooks.slack.com/services/XXX'
   ```
   Without it the notifier runs in dry-run mode and only logs the message.
3. Deploy, then break things on purpose:
   ```bash
   aws lambda invoke --function-name lambda-demo-08-alarm-slack-flaky out.json
   ```
4. The alarm goes ALARM within 1-2 minutes and Slack gets the message.
   The alarm returns to OK on its own once errors stop.

## 09 - GitHub webhook to deploy

1. In your repo add `.github/workflows/deploy.yml` with `on: workflow_dispatch`
   (optionally with an `inputs: sha` entry).
2. Create a fine-grained token with *Actions: read and write* on that repo.
3. Store secrets (choose any random string for the webhook secret):
   ```bash
   aws ssm put-parameter --name /lambda-demo/github/webhook-secret --type SecureString --value 'RANDOM'
   aws ssm put-parameter --name /lambda-demo/github/token --type SecureString --value 'github_pat_xxx'
   ```
   Without `token` the function runs in dry-run mode.
4. Set `GithubRepo` in `09-github-webhook-deploy/samconfig.toml`, deploy.
5. Repo -> Settings -> Webhooks -> Add: Payload URL = `WebhookUrl` output,
   content type `application/json`, secret = the same RANDOM, event = push.
6. Push to `main`. Check *Recent Deliveries* in GitHub and the Actions tab.

If GitHub shows 403 on delivery, the Function URL permission is missing; re-check
the `UrlInvokePermission` resource in the template.

---

## Cost guardrails

- Everything is pay-per-use. Expect cents or less for a single run-through.
- Delete stacks after recording: `make delete-all`.
- Log groups expire after 3 days, S3 demo buckets expire objects after 1 day.
- No VPC or NAT Gateway anywhere (that is the usual surprise bill).
- Thumbnail demo writes to a different bucket than it listens to; writing back to the
  trigger bucket would loop forever.
- Secrets live in SSM Parameter Store (free), not Secrets Manager ($0.40/secret/month).
- SSM parameters and the SES identity are created by you by hand, so `make delete-all`
  does not remove them. Remove with `aws ssm delete-parameter` and
  `aws sesv2 delete-email-identity`.
