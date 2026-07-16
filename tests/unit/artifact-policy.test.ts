import { ArtifactPolicy } from "../../src/main/domain/a2a/artifact-policy";

describe("A2A Artifact policy", () => {
  it("sanitizes names and accepts bounded task-declared metadata", () => {
    const policy = new ArtifactPolicy();
    expect(policy.validate({
      declaredOrigin: "http://agent.lan",
      filename: "report:final?.md",
      mimeType: "text/markdown",
      size: 1024,
      url: "http://agent.lan/artifacts/artifact_1",
    })).toMatchObject({ filename: "report_final_.md", preview: "markdown" });
    expect(policy.validate({ declaredOrigin: "http://agent.lan", filename: "data.csv", mimeType: "text/csv", size: 1, url: "http://agent.lan/a" }).preview).toBe("csv");
    expect(policy.validate({ declaredOrigin: "http://agent.lan", filename: "data.json", mimeType: "application/json", size: 1, url: "http://agent.lan/a" }).preview).toBe("json");
    expect(policy.validate({ declaredOrigin: "http://agent.lan", filename: "note.txt", mimeType: "text/plain", size: 1, url: "http://agent.lan/a" }).preview).toBe("text");
    expect(policy.validate({ declaredOrigin: "http://agent.lan", filename: "photo.png", mimeType: "image/png", size: 1, url: "http://agent.lan/a" }).preview).toBe("image");
    expect(policy.validate({ declaredOrigin: "http://agent.lan", filename: "archive", mimeType: "application/octet-stream", size: 0, url: "http://agent.lan/a" }).preview).toBe("none");
  });

  it("rejects traversal, cross-origin, executables and oversized files", () => {
    const policy = new ArtifactPolicy();
    expect(() => policy.validate({ declaredOrigin: "http://agent.lan", filename: "../secret.txt", mimeType: "text/plain", size: 1, url: "http://agent.lan/a" })).toThrow(/filename/);
    expect(() => policy.validate({ declaredOrigin: "http://agent.lan", filename: "file.txt", mimeType: "text/plain", size: 1, url: "http://other.lan/a" })).toThrow(/Origin/);
    expect(() => policy.validate({ declaredOrigin: "http://agent.lan", filename: "run.exe", mimeType: "application/x-msdownload", size: 1, url: "http://agent.lan/a" })).toThrow(/executable/i);
    expect(() => policy.validate({ declaredOrigin: "http://agent.lan", filename: "large.bin", mimeType: "application/octet-stream", size: 101 * 1024 * 1024, url: "http://agent.lan/a" })).toThrow(/100 MiB/);
    expect(() => policy.validate({ declaredOrigin: "http://agent.lan", filename: " ", mimeType: "text/plain", size: 1, url: "http://agent.lan/a" })).toThrow(/filename/);
    expect(() => policy.validate({ declaredOrigin: "http://agent.lan", filename: "file.txt", mimeType: "text/plain", size: 1, url: "not a url" })).toThrow(/URL/);
    expect(() => policy.validate({ declaredOrigin: "http://agent.lan", filename: "file.txt", mimeType: "text/plain", size: -1, url: "http://agent.lan/a" })).toThrow(/100 MiB/);
    expect(() => policy.validate({ declaredOrigin: "http://agent.lan", filename: "script", mimeType: "application/x-sh", size: 1, url: "http://agent.lan/a" })).toThrow(/executable/i);
  });
});
