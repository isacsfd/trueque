import { readFile, access } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("release-candidate");
const index = await readFile(path.join(root, "index.html"), "utf8");
const asset = index.match(/assets\/[^"']+\.js/)?.[0];
if (!asset) throw new Error("No JavaScript bundle found in release-candidate/index.html");

const bundle = await readFile(path.join(root, asset), "utf8");
const required = [
  ["Código de solicitud o reserva", "single-token status form"],
  ["Buscar por título", "catalogue search"],
  ["/api/catalog", "catalogue endpoint"],
  ["Solicitar este ejemplar", "catalogue selection"],
  ["Libro que ofreces", "legacy request intake"],
  ["/api/requests", "legacy request endpoint"],
  ["Panel administrativo", "admin panel"],
  ["Buscar solicitud", "admin search"],
  ["Ver historial", "lazy administrative history"],
  ["Alta de ejemplar", "manual inventory registration"],
  ["Publicar ahora", "eligible publication control"],
];
for (const [needle, label] of required) {
  if (!bundle.includes(needle)) throw new Error(`Release bundle is missing ${label}: ${needle}`);
}
if (bundle.includes("Clave de acceso")) throw new Error("Legacy password field leaked into the release bundle");

for (const file of ["catalogo.html", "admin.html", "admin.js"]) {
  await access(path.join(root, file));
}

console.log(JSON.stringify({
  asset,
  bytes: Buffer.byteLength(bundle, "utf8"),
  checks: required.map(([, label]) => label),
  legacy_password_field: false,
}, null, 2));
