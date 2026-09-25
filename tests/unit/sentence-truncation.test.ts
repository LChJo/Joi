import { truncateAtSentenceBoundary } from "../../src/main/domain/text/sentence-truncation";

describe("truncateAtSentenceBoundary", () => {
  it("returns short text untouched", () => {
    expect(truncateAtSentenceBoundary("第一层完成", 320)).toBe("第一层完成");
  });

  it("cuts at the last sentence boundary inside the limit", () => {
    const text = `首句。${"总".repeat(500)}。尾句。`;
    expect(truncateAtSentenceBoundary(text, 320)).toBe("首句。");
  });

  it("never extends past the limit when the crossing sentence has no boundary inside it", () => {
    expect(truncateAtSentenceBoundary(`${"总".repeat(400)}。尾句。`, 320)).toBe("总".repeat(320));
  });

  it("falls back to the plain character cut when no boundary exists inside the limit", () => {
    expect(truncateAtSentenceBoundary("总".repeat(2000), 320)).toBe("总".repeat(320));
  });

  it("treats newlines as boundaries and trims the trailing break", () => {
    const text = `第一节\n${"总".repeat(500)}`;
    expect(truncateAtSentenceBoundary(text, 320)).toBe("第一节");
  });

  it("only counts an ascii period followed by whitespace as a boundary", () => {
    expect(truncateAtSentenceBoundary("see fig.1 end. rest of the sentence follows here and there", 14)).toBe("see fig.1 end.");
  });
});
