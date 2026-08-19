import { readFile } from "node:fs/promises";

describe("composition root boundaries", () => {
  it("keeps repository, actor tree and outbox construction inside composition wiring modules", async () => {
    const composition = await readFile("src/main/index.ts", "utf8");
    expect(composition).not.toMatch(/new Sqlite[A-Za-z]+/u);
    for (const forbidden of [
      "new ActorTree(",
      "new JoiCoordinator(",
      "new LegacyLifeStoreAdapter(",
      "new OutboxDispatcher(",
    ]) {
      expect(composition).not.toContain(forbidden);
    }
    for (const wiringCall of [
      "wirePersistence(",
      "wireModelSources(",
      "wirePartners(",
      "wireWorkbenches(",
      "wireJoi(",
      "wireRuntime(",
    ]) {
      expect(composition).toContain(wiringCall);
    }
  });
});
