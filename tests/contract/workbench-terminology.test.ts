import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(".");
const roots = ["README.md", "docs", "src"];
const formerProductTerm = new RegExp(["ava", "tar"].join(""), "iu");

function productionFiles(relativePath: string): string[] {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const entries = readdirSync(absolutePath, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = path.join(relativePath, entry.name);
    return entry.isDirectory() ? productionFiles(child) : [child];
  });
}

function vocabularySurface(): string[] {
  return roots.flatMap((entry) => entry.endsWith(".md") ? [entry] : productionFiles(entry));
}

function removeUnrelatedProfileImageVocabulary(source: string): string {
  return source
    .replaceAll("avatarUrl", "profileImageUrl")
    .replaceAll("avatar_url", "profile_image_url")
    .replaceAll("life_avatar_invalid", "life_profile_image_invalid")
    .replaceAll("/avatar.png", "/profile-image.png");
}

describe("Workbench terminology boundary", () => {
  it("uses Workbench as the only active product name for the persistent context entity", () => {
    const violations = vocabularySurface().flatMap((relativePath) => {
      const fileName = path.basename(relativePath);
      const source = removeUnrelatedProfileImageVocabulary(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
      return formerProductTerm.test(fileName) || formerProductTerm.test(source) ? [relativePath.replaceAll("\\", "/")] : [];
    });

    expect(violations).toEqual([]);
  });
});
