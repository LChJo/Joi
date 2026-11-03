import { BuiltinPiCodingToolFactory } from "../../src/main/infrastructure/pi/pi-coding-tool-factory.js";
import { PiWebAccessToolFactory } from "../../src/main/infrastructure/pi/pi-web-access-tools.js";

describe("Pi web access tools", () => {
  it("are part of the default partner tool catalog", () => {
    const factory = new BuiltinPiCodingToolFactory();
    expect(factory.names).toEqual(expect.arrayContaining(["web_search", "fetch_content", "get_search_content"]));
  });

  it("fetches bounded readable content and pages it through an in-memory response id", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      "<html><head><title>Sandcastle</title></head><body><script>secret-not-content</script><main><h1>Sandcastle</h1><p>Readable project information.</p></main></body></html>",
      { headers: { "content-type": "text/html" } },
    ));
    const factory = new PiWebAccessToolFactory({
      fetchImpl,
      resolveHost: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      idGenerator: () => "response_1",
    });
    const [fetchContent, getSearchContent] = factory.create(["fetch_content", "get_search_content"]);
    if (fetchContent === undefined || getSearchContent === undefined) throw new Error("web tools missing");

    const fetched = await fetchContent.execute("call-1", { url: "https://example.com/article" });
    expect(fetched.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(fetched.content)).toContain("Readable project information.");
    expect(JSON.stringify(fetched.content)).not.toContain("secret-not-content");

    const responseId = (fetched.details as { responseId: string }).responseId;
    const page = await getSearchContent.execute("call-2", { responseId, limit: 1_000 });
    expect(JSON.stringify(page.content)).toContain("Readable project information.");
  });

  it("returns only the first page from fetch_content and keeps the full response pageable", async () => {
    const longContent = `start-${"x".repeat(25_000)}-end`;
    const factory = new PiWebAccessToolFactory({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(longContent, { headers: { "content-type": "text/plain" } })),
      resolveHost: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      idGenerator: () => "response_long",
    });
    const [fetchContent, getSearchContent] = factory.create(["fetch_content", "get_search_content"]);
    if (fetchContent === undefined || getSearchContent === undefined) throw new Error("web tools missing");

    const fetched = await fetchContent.execute("call-long", { url: "https://example.com/long.txt", mode: "raw" });
    const firstPage = JSON.stringify(fetched.content);
    expect(firstPage.length).toBeLessThan(21_000);
    expect(firstPage).toContain("start-");
    expect(firstPage).not.toContain("-end");
    expect(fetched.details).toMatchObject({ hasMore: true, nextOffset: 20_000, responseId: "response_long" });

    const next = await getSearchContent.execute("call-next", { responseId: "response_long", offset: 20_000, limit: 10_000 });
    expect(JSON.stringify(next.content)).toContain("-end");
  });

  it("rejects private network targets before issuing a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const factory = new PiWebAccessToolFactory({ fetchImpl });
    const [fetchContent] = factory.create(["fetch_content"]);
    if (fetchContent === undefined) throw new Error("fetch_content tool missing");

    await expect(fetchContent.execute("call-private", { url: "http://127.0.0.1:8080/admin" })).resolves.toMatchObject({ isError: true });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(fetchContent.execute("call-private-v6", { url: "http://[::1]:8080/admin" })).resolves.toMatchObject({ isError: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("searches public results and reads a GitHub repository README without cloning", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fmattpocock%2Fsandcastle">Sandcastle</a><a class="result__snippet">A public project.</a></div>`,
        { headers: { "content-type": "text/html" } },
      ))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("# Sandcastle\n\nA public project README.", { headers: { "content-type": "text/plain" } }));
    const factory = new PiWebAccessToolFactory({
      fetchImpl,
      resolveHost: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      idGenerator: (() => { let index = 0; return () => `response_${(++index).toString()}`; })(),
    });
    const [search, fetchContent] = factory.create(["web_search", "fetch_content"]);
    if (search === undefined || fetchContent === undefined) throw new Error("web tools missing");

    const searchResult = await search.execute("search-1", { query: "sandcastle" });
    expect(JSON.stringify(searchResult.content)).toContain("mattpocock/sandcastle");
    const githubResult = await fetchContent.execute("fetch-1", { url: "https://github.com/mattpocock/sandcastle" });
    expect(JSON.stringify(githubResult.content)).toContain("A public project README.");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("validates every redirect target before following it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      headers: { location: "http://127.0.0.1:8080/private" },
      status: 302,
    }));
    const factory = new PiWebAccessToolFactory({
      fetchImpl,
      resolveHost: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
    });
    const [fetchContent] = factory.create(["fetch_content"]);
    if (fetchContent === undefined) throw new Error("fetch_content tool missing");

    await expect(fetchContent.execute("redirect-private", { url: "https://example.com/start" })).resolves.toMatchObject({ isError: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
