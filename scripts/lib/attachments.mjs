import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024;
export const ATTACHMENT_RETENTION_MS = 48 * 60 * 60 * 1_000;

const STORAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-z0-9]{1,12})?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIME = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function secureDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);
}

function safeExtension(source) {
  const extension = path.extname(source).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "";
}

export function safeAttachmentName(value, source = "") {
  const fallback = `attachment${safeExtension(source)}`;
  const base = path.basename(String(value ?? "")).replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (!base || base === "." || base === "..") return fallback;
  return base.slice(0, 180);
}

export function normalizeAttachmentMime(value) {
  const mime = String(value ?? "").trim().toLowerCase();
  return MIME.test(mime) ? mime : "application/octet-stream";
}

export function validateAttachmentRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Attachment metadata is invalid");
  const storageName = String(value.storageName ?? "");
  const displayName = String(value.displayName ?? "");
  const mime = normalizeAttachmentMime(value.mime);
  const kind = value.kind === "image" ? "image" : value.kind === "file" ? "file" : null;
  if (!STORAGE_NAME.test(storageName)) throw new Error("Attachment storage identity is invalid");
  if (!displayName || displayName.length > 180 || CONTROL.test(displayName) || /[\r\n]/.test(displayName)) throw new Error("Attachment display name is invalid");
  if (!kind) throw new Error("Attachment kind is invalid");
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachment size is invalid");
  if (!SHA256.test(String(value.sha256 ?? ""))) throw new Error("Attachment digest is invalid");
  return { storageName, displayName, mime, kind, size: value.size, sha256: value.sha256 };
}

export function validateAttachmentRecords(values = []) {
  if (!Array.isArray(values) || values.length > MAX_ATTACHMENT_COUNT) throw new Error("Attachment count is invalid");
  const records = values.map(validateAttachmentRecord);
  if (records.reduce((total, record) => total + record.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error("Attachments are too large");
  if (new Set(records.map((record) => record.storageName)).size !== records.length) throw new Error("Attachment identities are duplicated");
  return records;
}

function configuredRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Attachment source root is invalid");
  return path.normalize(value);
}

function sourceDescriptor(input, roots) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string" || !path.isAbsolute(input.path)) {
    throw new Error("Attachment source is invalid");
  }
  const link = fs.lstatSync(input.path);
  if (!link.isFile() || link.isSymbolicLink()) throw new Error("Attachment source must be a regular file");
  const source = fs.realpathSync(input.path);
  if (!roots.some((root) => source !== root && source.startsWith(`${root}${path.sep}`))) throw new Error("Attachment source is outside the media cache");
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachment source size is invalid");
  return {
    source,
    size: stat.size,
    displayName: safeAttachmentName(input.name, source),
    mime: normalizeAttachmentMime(input.mime),
    kind: input.kind === "image" ? "image" : "file",
  };
}

function copyAndDigest(source, destination, expectedSize) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const sourceDescriptor = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
  let destinationDescriptor;
  try {
    const before = fs.fstatSync(sourceDescriptor);
    if (!before.isFile() || before.size !== expectedSize) throw new Error("Attachment source changed before staging");
    destinationDescriptor = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      const read = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > expectedSize || total > MAX_ATTACHMENT_BYTES) throw new Error("Attachment source changed while staging");
      fs.writeSync(destinationDescriptor, buffer, 0, read);
      hash.update(buffer.subarray(0, read));
    }
    const after = fs.fstatSync(sourceDescriptor);
    if (total !== expectedSize || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Attachment source changed while staging");
    fs.fsyncSync(destinationDescriptor);
    fs.closeSync(destinationDescriptor);
    destinationDescriptor = undefined;
    return hash.digest("hex");
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    fs.closeSync(sourceDescriptor);
  }
}

export class CodexAttachmentStore {
  constructor(root, sourceRoots = []) {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Attachment store path is invalid");
    this.root = root;
    this.sourceRoots = sourceRoots.map(configuredRoot);
  }

  stage(inputs = []) {
    if (!Array.isArray(inputs) || inputs.length > MAX_ATTACHMENT_COUNT) throw new Error("Attachment count is invalid");
    if (!inputs.length) return [];
    const activeRoots = this.sourceRoots.flatMap((root) => {
      try { return [fs.realpathSync(root)]; } catch { return []; }
    });
    if (!activeRoots.length) throw new Error("Attachment source roots are unavailable");
    const sources = inputs.map((input) => sourceDescriptor(input, activeRoots));
    if (sources.reduce((total, source) => total + source.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error("Attachments are too large");
    secureDirectory(this.root);
    const created = [];
    try {
      for (const source of sources) {
        const storageName = `${crypto.randomUUID()}${safeExtension(source.source)}`;
        const finalPath = path.join(this.root, storageName);
        const temporary = path.join(this.root, `.${storageName}.${process.pid}.tmp`);
        try {
          const sha256 = copyAndDigest(source.source, temporary, source.size);
          fs.renameSync(temporary, finalPath);
          fs.chmodSync(finalPath, 0o600);
          created.push({ storageName, displayName: source.displayName, mime: source.mime, kind: source.kind, size: source.size, sha256 });
        } finally {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
      }
      return created;
    } catch (error) {
      this.remove(created);
      throw error;
    }
  }

  pathFor(record) {
    const valid = validateAttachmentRecord(record);
    return path.join(this.root, valid.storageName);
  }

  remove(records = []) {
    for (const record of records) {
      try { fs.unlinkSync(this.pathFor(record)); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }

  sweep(referenced = new Set(), now = Date.now()) {
    if (!fs.existsSync(this.root)) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !STORAGE_NAME.test(entry.name) || referenced.has(entry.name)) continue;
      const target = path.join(this.root, entry.name);
      if (now - fs.statSync(target).mtimeMs < ATTACHMENT_RETENTION_MS) continue;
      fs.unlinkSync(target);
      removed += 1;
    }
    return removed;
  }
}

export function verifyMaterializedAttachment(target, record) {
  const valid = validateAttachmentRecord(record);
  const link = fs.lstatSync(target);
  if (!link.isFile() || link.isSymbolicLink() || link.size !== valid.size) throw new Error("Materialized attachment size does not match");
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const hash = crypto.createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > valid.size) throw new Error("Materialized attachment size does not match");
      hash.update(buffer.subarray(0, read));
    }
    if (total !== valid.size) throw new Error("Materialized attachment size does not match");
  } finally {
    fs.closeSync(descriptor);
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== valid.sha256) throw new Error("Materialized attachment digest does not match");
  fs.chmodSync(target, 0o600);
  return target;
}

export function attachmentFingerprint(records = []) {
  return crypto.createHash("sha256").update(JSON.stringify(validateAttachmentRecords(records).map(({ storageName, size, sha256, kind }) => ({ storageName, size, sha256, kind })))).digest("hex");
}
