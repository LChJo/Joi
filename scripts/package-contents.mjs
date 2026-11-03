const forbiddenPathPatterns = [
  { label: "environment file", pattern: /(?:^|\/)\.env(?:\.|$)/i },
  { label: "test output", pattern: /(?:^|\/)(?:coverage|playwright-report|test-results|tests?)(?:\/|$)/i },
  { label: "real user data", pattern: /(?:^|\/)(?:userData|userdata)(?:\/|$)/ },
  { label: "database sidecar", pattern: /\.(?:sqlite|sqlite-shm|sqlite-wal)$/i },
];

const forbiddenContentPatterns = [
  { label: "test-token-secret", pattern: /test-token-secret/i },
  { label: "Bearer credential", pattern: /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]+/i },
  { label: "source path", pattern: /[A-Za-z]:[\\/][^\n\r"'`]*[\\/](?:digital-life|joi)(?:[\\/]|\b)/i },
  { label: "source path", pattern: /\/(?:Users|home)\/[^\n\r"'`]+\/(?:digital-life|joi)(?:\/|\b)/i },
];

export function validatePackageContents(filePaths, textContents) {
  const violations = [];

  for (const filePath of filePaths) {
    const normalized = filePath.replaceAll("\\", "/");
    for (const { label, pattern } of forbiddenPathPatterns) {
      if (pattern.test(normalized)) {
        violations.push(`${label}: ${normalized}`);
      }
    }
  }

  for (const content of textContents) {
    for (const { label, pattern } of forbiddenContentPatterns) {
      if (pattern.test(content)) {
        violations.push(`${label} found in packaged text`);
      }
    }
  }

  return { violations };
}
