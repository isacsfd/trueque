import { randomBytes, scryptSync } from "node:crypto";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");

if (password.length < 12) {
  console.error("Use a password of at least 12 characters. Nothing was written.");
  process.exit(2);
}

const salt = randomBytes(16);
const derived = scryptSync(password, salt, 64);
process.stdout.write(`scrypt$${salt.toString("hex")}$${derived.toString("hex")}\n`);
