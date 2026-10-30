export const handler = async (event) => {
  for (const record of event.Records) {
    console.log(`[direct] subject=${record.Sns.Subject ?? '-'} message=${record.Sns.Message}`);
  }
};
