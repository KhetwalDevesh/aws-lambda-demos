// RawMessageDelivery is on, so record.body is the published message itself
export const handler = async (event) => {
  for (const record of event.Records) {
    console.log(`[buffered] message=${record.body}`);
  }
};
