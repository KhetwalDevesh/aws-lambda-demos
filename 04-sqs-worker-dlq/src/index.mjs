// Any message whose body contains the word "fail" is rejected, so you can watch
// it get retried 3 times and then land in the dead-letter queue.
export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      if (/fail/i.test(record.body)) throw new Error('simulated processing error');
      console.log(`OK    ${record.messageId} body=${record.body}`);
    } catch (err) {
      console.error(
        `FAIL  ${record.messageId} attempt=${record.attributes.ApproximateReceiveCount} ${err.message}`,
      );
      // Only this message returns to the queue; the rest of the batch is deleted
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
