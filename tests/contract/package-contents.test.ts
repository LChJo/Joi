import { validatePackageContents } from "../../scripts/package-contents.mjs";

describe("production package contents", () => {
  it("rejects secrets, development files, real user data, and source paths", () => {
    const result = validatePackageContents(
      [
        "dist/electron/main/index.js",
        "dist/renderer/index.html",
        ".env.production",
        "userData/life.sqlite",
      ],
      ["const token = 'test-token-secret';", "I:\\aimana\\digital-life"],
    );

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(".env.production"),
        expect.stringContaining("userData/life.sqlite"),
        expect.stringContaining("test-token-secret"),
        expect.stringContaining("source path"),
      ]),
    );
  });

  it("accepts the expected production shape", () => {
    const result = validatePackageContents(
      ["dist/electron/main/index.js", "dist/electron/preload/index.cjs", "dist/renderer/index.html"],
      ["joi", "urn:aimana:digital-life-runtime:v1"],
    );

    expect(result.violations).toEqual([]);
  });
});
