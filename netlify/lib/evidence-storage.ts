import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { evidenceExtension, type EvidenceMime } from "./evidence-validation.ts";

export interface StoredObjectInfo {
  key: string;
  size: number;
  lastModified: Date;
}

export interface EvidenceStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<StoredObjectInfo>;
  list(prefix?: string): Promise<StoredObjectInfo[]>;
}

const KEY_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const KNOWN_PROVIDER_DRIVERS = new Set(["r2", "s3", "gcs", "blobs", "netlify-blobs"]);

function storageRoot(environmentName: string, fallback: string): string {
  const configured = process.env[environmentName]?.trim();
  return configured || fallback;
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes("..")) {
    throw new Error("Invalid private storage key.");
  }
}

export class LocalEvidenceStorage implements EvidenceStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    assertKey(key);
    const target = resolve(this.root, key);
    if (!target.startsWith(`${this.root}${sep}`)) {
      throw new Error("Private storage path escapes the configured root.");
    }
    return target;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async head(key: string): Promise<StoredObjectInfo> {
    const info = await stat(this.pathFor(key));
    return { key, size: info.size, lastModified: info.mtime };
  }

  async list(prefix = ""): Promise<StoredObjectInfo[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: StoredObjectInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const info = await stat(join(this.root, entry.name));
      result.push({ key: entry.name, size: info.size, lastModified: info.mtime });
    }
    return result.sort((left, right) => left.key.localeCompare(right.key));
  }
}

/**
 * Deterministic in-memory adapter used only by automated tests and local
 * simulations. It is never selected by an external provider credential.
 */
export class SimulatedObjectStorage implements EvidenceStorage {
  private readonly objects = new Map<string, { bytes: Buffer; lastModified: Date }>();
  failNextPut = false;
  failNextDelete = false;

  async put(key: string, bytes: Buffer): Promise<void> {
    assertKey(key);
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("simulated storage write failure");
    }
    this.objects.set(key, { bytes: Buffer.from(bytes), lastModified: new Date() });
  }

  async get(key: string): Promise<Buffer> {
    assertKey(key);
    const object = this.objects.get(key);
    if (!object) throw new Error("simulated object not found");
    return Buffer.from(object.bytes);
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("simulated storage delete failure");
    }
    this.objects.delete(key);
  }

  async head(key: string): Promise<StoredObjectInfo> {
    assertKey(key);
    const object = this.objects.get(key);
    if (!object) throw new Error("simulated object not found");
    return { key, size: object.bytes.length, lastModified: object.lastModified };
  }

  async list(prefix = ""): Promise<StoredObjectInfo[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, object]) => ({ key, size: object.bytes.length, lastModified: object.lastModified }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}

const simulatedEvidence = new SimulatedObjectStorage();
const simulatedBatches = new SimulatedObjectStorage();

/**
 * Netlify Functions run on an ephemeral AWS Lambda filesystem. Writing private
 * objects there loses data on the next deploy or cold start, so local storage
 * must fail closed in hosted runtimes. `netlify dev` sets NETLIFY_DEV so local
 * development can keep using the local adapter.
 */
export function isHostedFunctionRuntime(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.NETLIFY_DEV === "true") return false;
  if (environment.NETLIFY === "true") return true;
  return Boolean(environment.AWS_LAMBDA_FUNCTION_NAME?.trim());
}

export function resolvePrivateStorageDriver(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PRIVATE_STORAGE_DRIVER?.trim().toLowerCase();
  if (configured) return configured;
  return isHostedFunctionRuntime(environment) ? "unconfigured" : "local";
}

function createStorage(
  environmentName: string,
  fallback: string,
  simulated: EvidenceStorage,
  environment: NodeJS.ProcessEnv = process.env,
): EvidenceStorage {
  const driver = resolvePrivateStorageDriver(environment);

  if (driver === "local") {
    if (isHostedFunctionRuntime(environment)) {
      throw new Error(
        "Private storage driver \"local\" is not durable in Netlify Functions. Configure an approved private object storage adapter before enabling uploads.",
      );
    }
    return new LocalEvidenceStorage(storageRoot(environmentName, fallback));
  }

  if (driver === "simulated") {
    if (isHostedFunctionRuntime(environment)) {
      throw new Error("The simulated private storage driver cannot run in Netlify Functions.");
    }
    return simulated;
  }

  if (KNOWN_PROVIDER_DRIVERS.has(driver)) {
    throw new Error(
      `Private storage driver "${driver}" is not implemented. It requires an approved provider, bucket and credentials; uploads stay disabled until that adapter exists.`,
    );
  }

  if (driver === "unconfigured") {
    throw new Error(
      "PRIVATE_STORAGE_DRIVER is required in Netlify Functions. Configure an approved private object storage adapter before enabling uploads.",
    );
  }

  // Never fall back to a local write: an unknown driver is a configuration error.
  throw new Error(
    `Unknown private storage driver "${driver}". Use local or simulated for development, or an approved provider adapter.`,
  );
}

export function getEvidenceStorage(): EvidenceStorage {
  return createStorage("EVIDENCE_STORAGE_DIR", join(process.cwd(), "var", "evidence"), simulatedEvidence);
}

export function getBatchStorage(): EvidenceStorage {
  return createStorage("BATCH_STORAGE_DIR", join(process.cwd(), "var", "batches"), simulatedBatches);
}

export function newUniqueObjectKey(prefix: string, extension: string): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 20) || "object";
  const safeExtension = extension.replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "bin";
  return `${safePrefix}-${randomUUID()}.${safeExtension}`;
}

export function newEvidenceStorageKey(mime: EvidenceMime): string {
  return newUniqueObjectKey("evidence", evidenceExtension(mime));
}
