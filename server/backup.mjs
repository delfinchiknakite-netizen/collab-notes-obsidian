import { readFile } from "node:fs/promises";
import AWS from "aws-sdk";
const s3 = new AWS.S3({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || "ru-central1",
  accessKeyId: process.env.S3_ACCESS_KEY,
  secretAccessKey: process.env.S3_SECRET_KEY,
  s3ForcePathStyle: true,
  signatureVersion: "v4"
});
const bytes = await readFile((process.env.ACCOUNT_DIR || "/data/accounts") + "/accounts.json");
JSON.parse(bytes.toString("utf8"));
await s3.putObject({
  Bucket: process.env.S3_BUCKET,
  Key: "account-backups/" + (/* @__PURE__ */ new Date()).toISOString().replace(/:/g, "-") + ".json",
  Body: bytes,
  ContentType: "application/json"
}).promise();
console.log("Account backup saved");
