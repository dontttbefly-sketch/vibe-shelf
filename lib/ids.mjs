import path from "node:path";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:\//;

export function assertId(value, label = "id") {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

export function assertRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("invalid relative path");
  }

  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    WINDOWS_ABSOLUTE.test(normalized)
  ) {
    throw new Error("invalid relative path");
  }
  return normalized;
}

export function isInsideRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}
