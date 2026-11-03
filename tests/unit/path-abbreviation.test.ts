import { abbreviateAbsolutePaths, abbreviatePath } from "../../src/main/domain/text/path-abbreviation";

describe("abbreviatePath", () => {
  it("returns a path that already fits in three segments untouched", () => {
    expect(abbreviatePath("C:\\work\\prd.md")).toBe("C:\\work\\prd.md");
    expect(abbreviatePath("/tmp/a.md")).toBe("/tmp/a.md");
    expect(abbreviatePath("D:/private/out.txt")).toBe("D:/private/out.txt");
  });

  it("keeps the drive and the last three segments", () => {
    expect(abbreviatePath("C:\\Users\\Bry\\AppData\\Roaming\\joi\\runtime.sqlite"))
      .toBe("C:\\…\\Roaming\\joi\\runtime.sqlite");
  });

  it("keeps the separator style the path already used", () => {
    expect(abbreviatePath("C:/Users/Bry/AppData/Roaming/joi/runtime.sqlite"))
      .toBe("C:/…/Roaming/joi/runtime.sqlite");
  });

  it("keeps the posix root", () => {
    expect(abbreviatePath("/Users/bry/projects/joi/src/main.ts")).toBe("/…/joi/src/main.ts");
  });

  it("counts an unc share as the root rather than as segments", () => {
    expect(abbreviatePath("\\\\srv\\share\\a\\b\\c\\d")).toBe("\\\\srv\\share\\…\\b\\c\\d");
    expect(abbreviatePath("\\\\srv\\share\\a\\b\\c")).toBe("\\\\srv\\share\\a\\b\\c");
  });

  it("leaves a bare root untouched", () => {
    expect(abbreviatePath("/")).toBe("/");
    expect(abbreviatePath("C:\\")).toBe("C:\\");
    expect(abbreviatePath("\\\\srv\\share")).toBe("\\\\srv\\share");
  });

  it("leaves a relative path untouched", () => {
    expect(abbreviatePath("relative/path/x/y")).toBe("relative/path/x/y");
  });

  it("is idempotent, so a second pass never eats another segment", () => {
    const once = abbreviatePath("C:\\Users\\Bry\\AppData\\Roaming\\joi\\runtime.sqlite");
    expect(abbreviatePath(once)).toBe(once);
  });

  it("keeps trailing punctuation inside the last kept segment", () => {
    expect(abbreviatePath("C:\\a\\b\\c\\d,")).toBe("C:\\…\\b\\c\\d,");
    expect(abbreviatePath("\\\\srv\\share\\a\\b\\c\\d)")).toBe("\\\\srv\\share\\…\\b\\c\\d)");
  });

  it("honours a custom keep", () => {
    expect(abbreviatePath("/a/b/c/d/e", 2)).toBe("/…/d/e");
    expect(abbreviatePath("/a/b/c/d/e", 9)).toBe("/a/b/c/d/e");
  });
});

describe("abbreviateAbsolutePaths", () => {
  const POSIX = /(?:^|\s)\/[\w/.]+/gu;

  it("preserves the leading whitespace the call site's pattern consumed", () => {
    expect(abbreviateAbsolutePaths("at /tmp/a/b/c/d", POSIX)).toBe("at /…/b/c/d");
  });

  it("abbreviates every path in a longer text", () => {
    const text = "read C:\\Users\\Bry\\AppData\\Roaming\\joi\\a.txt then /tmp/a/b/c/d";
    expect(abbreviateAbsolutePaths(text, /(?:^|\s)(?:[A-Za-z]:[\\/]|\\\\)[^\s]+|(?:^|\s)\/[\w/.]+/gu))
      .toBe("read C:\\…\\Roaming\\joi\\a.txt then /…/b/c/d");
  });

  it("stays stable when applied twice", () => {
    const once = abbreviateAbsolutePaths("at /tmp/a/b/c/d", POSIX);
    expect(abbreviateAbsolutePaths(once, POSIX)).toBe(once);
  });
});
