import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(".");
const roots = ["README.md", "docs", "src"];
const formerProductTerm = new RegExp(["ava", "tar"].join(""), "iu");
const textExtensions = new Set([".md", ".ts", ".tsx", ".cts", ".css", ".html", ".svg", ".json"]);

function isProductVocabularySurface(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  // Branding references and image-generation prompts describe portraits, not persistent contexts.
  return !normalized.startsWith("docs/design/")
    && normalized !== "docs/joi-brand-assets.md"
    && textExtensions.has(path.extname(relativePath));
}

function productionFiles(relativePath: string): string[] {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const entries = readdirSync(absolutePath, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = path.join(relativePath, entry.name);
    return entry.isDirectory() ? productionFiles(child) : isProductVocabularySurface(child) ? [child] : [];
  });
}

function vocabularySurface(): string[] {
  return roots.flatMap((entry) => entry.endsWith(".md") ? [entry] : productionFiles(entry));
}

function removeNonProductVocabulary(source: string): string {
  return source
    // Historical migration filenames remain stable for source references and database upgrades.
    .replace(/\b(?:019_avatar_change_confirmation|027_avatar_private_partner_results)\.sql\b/gu, "legacy-migration.sql")
    .replaceAll("joi-brand-avatar", "joi-brand-profile-image")
    .replaceAll("joi-avatar", "joi-profile-image")
    .replaceAll("avatarUrl", "profileImageUrl")
    .replaceAll("avatar_url", "profile_image_url")
    .replaceAll("life_avatar_invalid", "life_profile_image_invalid")
    .replaceAll("/avatar.png", "/profile-image.png");
}

describe("Workbench terminology boundary", () => {
  it("uses Workbench as the only active product name for the persistent context entity", () => {
    const violations = vocabularySurface().flatMap((relativePath) => {
      const fileName = path.basename(relativePath);
      const source = removeNonProductVocabulary(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
      return formerProductTerm.test(fileName) || formerProductTerm.test(source) ? [relativePath.replaceAll("\\", "/")] : [];
    });

    expect(violations).toEqual([]);
  });
});
