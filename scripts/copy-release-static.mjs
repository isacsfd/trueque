import { copyFile, mkdir, access } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("release");
const target = path.resolve("release-candidate");

await mkdir(target, { recursive: true });
for (const file of ["catalogo.html", "admin.html", "admin.js"]) {
  await copyFile(path.join(source, file), path.join(target, file));
  await access(path.join(target, file));
}
console.log("Copied legacy static pages into release-candidate");
