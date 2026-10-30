# Serverless Playground - AWS Lambda demos

Nine small demos, each its own SAM stack (Node.js 22, arm64). Each one shows a
different way to trigger a Lambda function.

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
| 09 | `09-github-webhook-deploy` | Function URL | Verify HMAC, dispatch GitHub Actions workflow |

## One-time setup

### 1. Pick your region first

The stacks are configured for `ap-southeast-2` (Sydney).

Accounts created with the newer AWS sign-up (AWS Settings, projects, Free Tier) are
locked to one region, assigned from your contact country. India and most of Asia
Pacific get Sydney. Find yours at <https://settings.aws.com> under
Projects -> Additional info -> Region.

If you deploy anywhere else, every call fails with:

```
... with an explicit deny in a service control policy
```

No IAM permission fixes this. If your region is different, change the configs:

```bash
sed -i '' 's/^region = .*/region = "YOUR_REGION"/' 0*/samconfig.toml
```

### 2. Install the tools

You need the AWS CLI, Node.js 22, `jq`, and Docker (for demo 03).

```bash
brew install aws-sam-cli
sam validate -h    # must print help
```

If `sam validate` says `No such command 'validate'`, the Homebrew build is broken on
your Python version. Install it in a Python 3.13 virtualenv instead:

```bash
brew uninstall aws-sam-cli
/opt/homebrew/opt/python@3.13/bin/python3.13 -m venv ~/.venvs/sam
~/.venvs/sam/bin/pip install aws-sam-cli
ln -sf ~/.venvs/sam/bin/sam /opt/homebrew/bin/sam
```

### 3. Configure credentials

Create an IAM user with `AdministratorAccess` and an access key for CLI use, then:

```bash
aws configure --profile personal    # use your region from step 1
aws sts get-caller-identity --profile personal
```

The configs use a profile named `personal`. Never commit access keys.

### 4. Add your email

Demos 05 and 06 read it from `.env`, which git ignores:

```bash
cp .env.example .env    # then edit DEMO_EMAIL
```

Deploy these with `make`. Plain `sam deploy` won't pick up the email.

### 5. Optional: budget alert

On the Free Tier the account can't be charged. On a paid plan, set this up first:

```bash
export AWS_PROFILE=personal
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws budgets create-budget --account-id $ACCOUNT \
  --budget '{"BudgetName":"lambda-demo","BudgetLimit":{"Amount":"1","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"YOUR_EMAIL"}]}]'
```

## Deploy

```bash
make deploy D=01-crud-api     # sam build + sam deploy
make delete D=01-crud-api     # tear down one demo
```

## Run this in every new terminal

Variables only last for that terminal. Without this block you get `NoCredentials`, or
`curl: option : blank argument` from an empty URL.

```bash
export AWS_PROFILE=personal AWS_REGION=ap-southeast-2

# out <stack> <output>: read a value from a deployed stack
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

# logs <function> [since]: recent logs without the START/END/REPORT noise
logs() { aws logs tail "/aws/lambda/lambda-demo-$1" --since "${2:-5m}" --format short | grep -vE 'START RequestId|END RequestId|REPORT RequestId|INIT_START|^$'; }
```

Each demo below sets the variables it needs. A stack must be deployed before its
`out` lines return anything.

**Logs lag.** Allow up to 30 seconds after an event, then run `logs`. `make logs`
(`sam logs --tail`) showed nothing in a 28-second test, so use `logs` instead.

---

## 01 - CRUD API

```bash
CRUD=$(out lambda-demo-01-crud-api ApiUrl)

curl -s -X POST "$CRUD" -H 'content-type: application/json' -d '{"title":"learn lambda"}' | jq
ID=$(curl -s "$CRUD" | jq -r '.[0].id')
curl -s -X PUT "$CRUD/$ID" -H 'content-type: application/json' -d '{"done":true}' | jq
curl -s "$CRUD/$ID" | jq
curl -s -o /dev/null -w 'DELETE: %{http_code}\n' -X DELETE "$CRUD/$ID"
curl -s -o /dev/null -w 'GET after delete: %{http_code}\n' "$CRUD/$ID"
```

Expect `204`, then `404`.

## 02 - Presigned upload

```bash
UPLOAD=$(out lambda-demo-02-presigned-upload ApiUrl)
UPLOAD_BUCKET=$(out lambda-demo-02-presigned-upload BucketName)
PHOTO=~/Desktop/photo.jpg    # any JPEG

RES=$(curl -s "$UPLOAD?filename=photo.jpg&contentType=image/jpeg")
echo "$RES" | jq '{key, expiresInSeconds}'
URL=$(echo "$RES" | jq -r .uploadUrl)
curl -s -o /dev/null -w 'S3 upload: %{http_code}\n' -X PUT "$URL" -H 'content-type: image/jpeg' --data-binary @"$PHOTO"
aws s3 ls "s3://$UPLOAD_BUCKET/uploads/" --human-readable
```

## 03 - S3 thumbnail

Docker must be running when you deploy (the Makefile adds `--use-container` for sharp).

```bash
SRC=$(out lambda-demo-03-s3-thumbnail SourceBucketName)
THUMBS=$(out lambda-demo-03-s3-thumbnail ThumbBucketName)

aws s3 cp ~/Desktop/photo.jpg "s3://$SRC/" --quiet
sleep 15
aws s3 ls "s3://$THUMBS/thumbs/" --human-readable
logs 03-s3-thumbnail-thumbnail 2m
```

Non-image files are skipped, and the log says `skip non-image`.

## 04 - SQS worker + DLQ

```bash
JOBS=$(out lambda-demo-04-sqs-worker-dlq JobsQueueUrl)
DLQ=$(out lambda-demo-04-sqs-worker-dlq DeadLetterQueueUrl)

aws sqs send-message --queue-url "$JOBS" --message-body "hello" --query MessageId --output text
aws sqs send-message --queue-url "$JOBS" --message-body "please fail" --query MessageId --output text
```

Wait 30 seconds, then `logs 04-sqs-worker-dlq-worker 2m`.

Any message containing "fail" is rejected. It gets 3 attempts over about 2 minutes,
then moves to the dead-letter queue. After about 3 minutes:

```bash
logs 04-sqs-worker-dlq-worker 5m | grep FAIL
aws sqs receive-message --queue-url "$DLQ" --query 'Messages[0].Body' --output text
```

## 05 - SNS fan-out

Confirm the email AWS sends after the first deploy, or the email branch stays
`PendingConfirmation`.

```bash
TOPIC=$(out lambda-demo-05-sns-fanout TopicArn)
aws sns publish --topic-arn "$TOPIC" --subject "New order" --message '{"orderId":42,"total":999}' --query MessageId --output text
```

Wait 30 seconds:

```bash
logs 05-sns-fanout-direct 2m
logs 05-sns-fanout-buffered 2m
```

## 06 - Daily report

SES starts in sandbox mode, so verify your address in the deploy region and click the
link in the email. One address is enough when sender and recipient are the same.

```bash
aws sesv2 create-email-identity --email-identity you@example.com
```

Deploy, then trigger on demand instead of waiting for 09:00:

```bash
aws scheduler get-schedule --name ReportFunctionDaily --query '{cron:ScheduleExpression,timezone:ScheduleExpressionTimezone,state:State}' --output table
aws lambda invoke --function-name lambda-demo-06-daily-report-report --query StatusCode --output text out.json
logs 06-daily-report-report 2m
```

Check spam. The schedule keeps emailing you daily until you delete the stack.

## 07 - DynamoDB Streams audit

Wait about a minute after deploying before the first write. With
`StartingPosition: LATEST`, changes made before the stream connection is live are not
delivered.

```bash
CUSTOMERS=$(out lambda-demo-07-ddb-streams-audit CustomersTableName)
AUDIT=$(out lambda-demo-07-ddb-streams-audit AuditTableName)

aws dynamodb put-item --table-name "$CUSTOMERS" --item '{"id":{"S":"cust-100"},"name":{"S":"Asha"},"plan":{"S":"free"}}'
aws dynamodb update-item --table-name "$CUSTOMERS" --key '{"id":{"S":"cust-100"}}' --update-expression 'SET #p = :p' --expression-attribute-names '{"#p":"plan"}' --expression-attribute-values '{":p":{"S":"pro"}}'
aws dynamodb delete-item --table-name "$CUSTOMERS" --key '{"id":{"S":"cust-100"}}'
sleep 12
aws dynamodb query --table-name "$AUDIT" --key-condition-expression 'itemId = :i' --expression-attribute-values '{":i":{"S":"cust-100"}}' --query 'Items[].[action.S,changes.M.plan.M.from.S,changes.M.plan.M.to.S]' --output text
```

You should see INSERT, MODIFY (`free -> pro`) and REMOVE. Audit rows expire after 24
hours.

## 08 - Alarm to Slack

1. Create a Slack app with an incoming webhook (<https://api.slack.com/apps>).
2. Store the URL. Parameter Store is regional, so use your deploy region:
   ```bash
   aws ssm put-parameter --name /lambda-demo/slack-webhook --type SecureString \
     --value 'https://hooks.slack.com/services/XXX'
   ```
   Without it the notifier runs in dry-run mode and only logs the message.
3. Deploy, then break things on purpose:
   ```bash
   for i in 1 2 3; do aws lambda invoke --function-name lambda-demo-08-alarm-slack-flaky --query FunctionError --output text out.json; done
   ```
4. Allow 2 to 3 minutes. The alarm goes to ALARM and Slack gets the message.

The alarm returns to OK by itself but doesn't send a recovery message. It must be OK
before it can fire again, so wait a few minutes between runs.

## 09 - GitHub webhook to deploy

The workflow is at `.github/workflows/deploy.yml`. It only prints the commit SHA. A
real deploy would add an AWS role and `sam deploy`.

1. Set `GithubRepo` in `09-github-webhook-deploy/samconfig.toml` to your `owner/repo`.
2. Create a fine-grained token limited to that repo, with *Actions: read and write*.
3. Store the secrets:
   ```bash
   SECRET=$(openssl rand -hex 32)
   aws ssm put-parameter --name /lambda-demo/github/webhook-secret --type SecureString --value "$SECRET"
   aws ssm put-parameter --name /lambda-demo/github/token --type SecureString --value 'github_pat_xxx'
   ```
   Without `token` the function runs in dry-run mode.
4. Deploy, then add the webhook to the repo:
   ```bash
   gh api repos/OWNER/REPO/hooks --method POST -f name=web \
     -f "config[url]=$(out lambda-demo-09-github-webhook WebhookUrl)" \
     -f 'config[content_type]=json' -f "config[secret]=$SECRET" \
     -f 'events[]=push' -F active=true --jq .id
   ```
5. Test it. An unsigned request gets rejected, and a push starts the workflow:
   ```bash
   curl -s -X POST "$(out lambda-demo-09-github-webhook WebhookUrl)" -d '{}' | jq
   git commit --allow-empty -m "chore: trigger deploy demo"
   git push origin main
   sleep 20
   gh run list --limit 1
   ```

Every push to `main` starts the workflow, including documentation changes.

If GitHub shows 403 on delivery, the Function URL permission is missing. Re-check the
`UrlInvokePermission` resource in the template.

---

## See it in the AWS Console

Stay in your deploy region.

| Look at | Open |
|---|---|
| Everything deployed | CloudFormation -> Stacks -> Resources |
| What triggers a function | Lambda -> Functions -> your function -> Configuration -> Triggers |
| Invocations, errors, logs | Lambda -> your function -> Monitor |
| Data | DynamoDB -> Tables -> Explore items; S3 -> Buckets |
| Queues | SQS -> your queue -> Send and receive messages -> Poll for messages |
| Schedule | EventBridge -> Schedules |
| Alarm history | CloudWatch -> Alarms -> History |
| API calls made | CloudTrail -> Event history |

## Clean up

CloudFormation can't delete a bucket that still has files, so empty them first:

```bash
aws s3 rm "s3://$(out lambda-demo-02-presigned-upload BucketName)" --recursive
aws s3 rm "s3://$(out lambda-demo-03-s3-thumbnail SourceBucketName)" --recursive
aws s3 rm "s3://$(out lambda-demo-03-s3-thumbnail ThumbBucketName)" --recursive
make delete-all
```

Check that nothing is left in CloudFormation -> Stacks.

These aren't part of the stacks, so remove them yourself:

```bash
aws ssm delete-parameters --names /lambda-demo/slack-webhook /lambda-demo/github/webhook-secret /lambda-demo/github/token
aws sesv2 delete-email-identity --email-identity you@example.com
```

Also remove:

- `aws-sam-cli-managed-default`: SAM's helper stack. Empty its S3 bucket, including
  all versions, then delete the stack in CloudFormation.
- The GitHub repo webhook and the fine-grained token.
- The Slack webhook, on the app's Incoming Webhooks page.
- The IAM user's access key, once you're done with the project.

## Cost guardrails

- On the Free Tier the account can't be charged. Credits cover usage beyond the free
  limits. On a paid plan, expect cents or less for one run-through.
- Log groups expire after 3 days, and demo S3 objects expire after 1 day.
- No VPC or NAT Gateway anywhere (that is the usual surprise bill).
- The thumbnail demo writes to a different bucket than it listens to. Writing back to
  the trigger bucket would loop forever.
- Secrets live in SSM Parameter Store (free), not Secrets Manager ($0.40/secret/month).

## Security notes

- The demo 01 and 02 APIs have no login. Don't share their URLs.
- The demo 09 Function URL is public by design. Its protection is the HMAC signature
  check, so keep the webhook secret private.
