#!/bin/bash
set -euo pipefail

echo "Criando fila de mensagens mortas..."

DLQ_URL="$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true \
  --query 'QueueUrl' \
  --output text)"

DLQ_ARN="$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"

printf '{"FifoQueue":"true","ContentBasedDeduplication":"true","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"5\\"}"}' \
  "$DLQ_ARN" > /tmp/main-queue-attributes.json

echo "Criando fila principal com política de redrive..."

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes file:///tmp/main-queue-attributes.json

echo "Filas SQS configuradas."
