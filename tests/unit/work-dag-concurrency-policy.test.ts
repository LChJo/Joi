import {
  buildWorkExecutionWaves,
  createWorkItem,
  type WorkDependency,
} from "../../src/main/domain/work/work.js";

describe("joi-work-dag-concurrency-policy", () => {
  it("supports non-file work without a workspace lease", () => {
    const none = createWorkItem({ accessMode: "NONE", avatarId: "avatar-1", createdAt: "2026-07-28T10:00:00.000Z", title: "归纳", workId: "none" });
    const write = createWorkItem({ accessMode: "WRITE", avatarId: "avatar-1", createdAt: "2026-07-28T10:00:00.000Z", title: "修改", workId: "write" });
    expect(buildWorkExecutionWaves([none, write], [])).toEqual([["none", "write"]]);
  });

  it("runs independent work concurrently and delays dependent work", () => {
    const a = createWorkItem({ accessMode: "READ", avatarId: "avatar-1", createdAt: "2026-07-28T10:00:00.000Z", title: "研究 A", workId: "a" });
    const b = createWorkItem({ accessMode: "READ", avatarId: "avatar-1", createdAt: "2026-07-28T10:00:00.000Z", title: "研究 B", workId: "b" });
    const c = createWorkItem({ accessMode: "WRITE", avatarId: "avatar-1", createdAt: "2026-07-28T10:00:00.000Z", title: "整合", workId: "c" });
    const dependencies: WorkDependency[] = [{ dependsOnWorkId: "a", workId: "c" }, { dependsOnWorkId: "b", workId: "c" }];
    expect(buildWorkExecutionWaves([a, b, c], dependencies)).toEqual([["a", "b"], ["c"]]);
  });

  it("serializes same-workspace writes and rejects cycles or cross-Avatar dependencies", () => {
    const first = createWorkItem({ accessMode: "WRITE", avatarId: "avatar-1", createdAt: "2026-07-28T10:00:00.000Z", title: "写 A", workId: "a" });
    const second = createWorkItem({ accessMode: "WRITE", avatarId: "avatar-1", createdAt: "2026-07-28T10:00:00.000Z", title: "写 B", workId: "b" });
    expect(buildWorkExecutionWaves([first, second], [])).toEqual([["a"], ["b"]]);
    expect(() => buildWorkExecutionWaves([first, second], [{ dependsOnWorkId: "b", workId: "a" }, { dependsOnWorkId: "a", workId: "b" }])).toThrow(/cycle/iu);
    const other = createWorkItem({ accessMode: "READ", avatarId: "avatar-2", createdAt: "2026-07-28T10:00:00.000Z", title: "另一个上下文", workId: "other" });
    expect(() => buildWorkExecutionWaves([first, other], [{ dependsOnWorkId: "other", workId: "a" }])).toThrow(/Avatar/iu);
  });
});
