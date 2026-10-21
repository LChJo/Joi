// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { PartnerDto, ScenarioPackDto } from "../../src/shared/joi";
import { DigitalLifeApi } from "../../src/renderer/api";
import { PartnerPage } from "../../src/renderer/PartnerPage";

const partner = (id: string): PartnerDto => ({
  partnerId: id, partnerRevisionId: `${id}-revision`, displayName: `Installed ${id}`, capabilities: [],
  createdBy: "joi", engine: "pi-core", inFlightCount: 0, kind: "local-pi", knowledgeDocCount: 0,
  lifecyclePolicy: "DRAIN", promptConfigured: true, registryRevision: 1, skills: [], status: "ACTIVE", tools: [],
});
const pack: ScenarioPackDto = {
  id: "programming", title: "安装回归套件", blurb: "fixture", definitionVersion: 1,
  installedRoleCount: 0, totalRoleCount: 2, status: "NOT_INSTALLED",
  source: { license: "fixture", repository: "joi/builtin", revision: "fixture" },
  teams: [{ id: "team", title: "回归团队", blurb: "fixture", roles: ["one", "two"].map(id => ({
    id, roleId: id, title: id, blurb: id, status: "NOT_INSTALLED",
  })) }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function setup() {
  const api = new DigitalLifeApi("");
  let items: PartnerDto[] = [];
  const list = vi.spyOn(api, "listPartners").mockImplementation(() => Promise.resolve({ items: [...items] }));
  const sourceRead = vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [] });
  vi.spyOn(api, "engineCatalog").mockResolvedValue({ items: [] });
  const packs = vi.spyOn(api, "scenarioPacks").mockImplementation(() => Promise.resolve({ items: [{
    ...pack, installedRoleCount: items.length, status: items.length ? "ACTIVE" : "NOT_INSTALLED",
  }] }));
  const result = { installedRoleCount: 2, packId: pack.id, status: "ACTIVE" as const,
    outcomes: ["one", "two"].map(roleId => ({ roleId, partnerId: roleId, outcome: "CREATED" as const })) };
  const install = vi.spyOn(api, "installScenarioPack").mockImplementation(() => {
    items = [partner("one"), partner("two")];
    return Promise.resolve(result);
  });
  function Page() {
    const [tab, setTab] = useState<"partners" | "scenarios">("scenarios");
    return <PartnerPage api={api} tab={tab} onTabChange={setTab} />;
  }
  return { api, Page, list, sourceRead, packs, install, result, setItems: (next: PartnerDto[]) => { items = next; } };
}
async function openPack() { fireEvent.click(await screen.findByRole("button", { name: /安装回归套件/u })); }
function catalog() { fireEvent.click(screen.getByRole("tab", { name: "搭档目录" })); }

describe("scenario installation catalog synchronization", () => {
  it.each(["安装完整套件", "安装回归团队"])("shows installed partners immediately after %s", async button => {
    const fixture = setup();
    render(<fixture.Page />);
    await openPack();
    fireEvent.click(screen.getByRole("button", { name: button }));
    await screen.findByText(/新建 2 位/u);
    catalog();
    expect(await screen.findByText("Installed one")).toBeInTheDocument();
    expect(screen.getByText("Installed two")).toBeInTheDocument();
  });

  it("shows committed roles after partial failure and after retry", async () => {
    const fixture = setup();
    fixture.install.mockImplementationOnce(() => {
      fixture.setItems([partner("one")]);
      return Promise.reject(new Error("private installation failure"));
    });
    render(<fixture.Page />);
    await openPack();
    fireEvent.click(screen.getByRole("button", { name: "安装完整套件" }));
    expect(await screen.findByText(/可重试补齐/u)).toBeInTheDocument();
    expect(await screen.findByText(/1\/2 位/u)).toBeInTheDocument();
    expect(screen.queryByText(/private installation failure/u)).not.toBeInTheDocument();
    catalog();
    expect(await screen.findByText("Installed one")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "场景预设" }));
    await openPack();
    fireEvent.click(screen.getByRole("button", { name: "安装完整套件" }));
    await screen.findByText(/新建 2 位/u);
    catalog();
    expect(await screen.findByText("Installed two")).toBeInTheDocument();
    expect(screen.getAllByText("Installed one")).toHaveLength(1);
  });

  it("keeps the in-flight installation locked when changing tabs", async () => {
    const fixture = setup();
    const pending = deferred<typeof fixture.result>();
    fixture.install.mockReturnValueOnce(pending.promise);
    render(<fixture.Page />);
    await openPack();
    fireEvent.click(screen.getByRole("button", { name: "安装完整套件" }));
    catalog();
    fireEvent.click(screen.getByRole("tab", { name: "场景预设" }));
    await openPack();
    expect(screen.getByRole("button", { name: "安装中…" })).toBeDisabled();
    fixture.setItems([partner("one"), partner("two")]);
    await act(async () => { pending.resolve(fixture.result); await pending.promise; });
    catalog();
    expect(await screen.findByText("Installed one")).toBeInTheDocument();
    expect(fixture.install).toHaveBeenCalledOnce();
  });

  it("loads partners independently of failed or slow model-source reads", async () => {
    const fixture = setup();
    fixture.setItems([partner("one")]);
    fixture.sourceRead.mockRejectedValue(new Error("private source failure"));
    vi.spyOn(fixture.api, "testPartnerModel").mockResolvedValue({ partnerId: "one", status: "READY", testedAt: "2026-10-21T00:00:00.000Z" });
    render(<fixture.Page />);
    catalog();
    expect(await screen.findByText("Installed one")).toBeInTheDocument();
    expect(screen.getByText(/模型配置状态暂不可核验/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "测试模型" }));
    expect(await screen.findByText("模型可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByText(/模型配置状态暂不可核验/u)).toBeInTheDocument();
  });

  it("finishes catalog synchronization while the model-source request is still pending", async () => {
    const fixture = setup();
    const sources = deferred<Awaited<ReturnType<DigitalLifeApi["listModelSources"]>>>();
    fixture.sourceRead.mockReturnValue(sources.promise);
    render(<fixture.Page />);
    await openPack();
    fireEvent.click(screen.getByRole("button", { name: "安装完整套件" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "安装完整套件" })).toBeEnabled());
    catalog();
    expect(await screen.findByText("Installed one")).toBeInTheDocument();
    await act(async () => { sources.resolve({ items: [] }); await sources.promise; });
  });

  it("ignores a stale mount response after the installation refresh", async () => {
    const fixture = setup();
    const stale = deferred<{ items: PartnerDto[] }>();
    fixture.list.mockReturnValueOnce(stale.promise);
    render(<fixture.Page />);
    await openPack();
    fireEvent.click(screen.getByRole("button", { name: "安装完整套件" }));
    await screen.findByText(/新建 2 位/u);
    await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(2));
    catalog();
    expect(await screen.findByText("Installed one")).toBeInTheDocument();
    await act(async () => { stale.resolve({ items: [] }); await stale.promise; });
    expect(screen.getByText("Installed one")).toBeInTheDocument();
  });

  it("keeps installed cards on refresh failure and provides an explicit retry", async () => {
    const fixture = setup();
    fixture.setItems([partner("one")]);
    render(<fixture.Page />);
    await openPack();
    await waitFor(() => expect(fixture.list).toHaveBeenCalledOnce());
    fixture.list.mockRejectedValueOnce(new Error("private list failure"));
    fireEvent.click(screen.getByRole("button", { name: "安装完整套件" }));
    await screen.findByText(/新建 2 位/u);
    catalog();
    expect(screen.getByText("Installed one")).toBeInTheDocument();
    expect(screen.getByText(/没能读取统一搭档目录/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("Installed two")).toBeInTheDocument();
  });

  it("retains suite progress when its refresh fails and retries without reinstalling", async () => {
    const fixture = setup();
    render(<fixture.Page />);
    await openPack();
    fixture.packs.mockRejectedValueOnce(new Error("private pack failure"));
    fireEvent.click(screen.getByRole("button", { name: "安装完整套件" }));
    await screen.findByText(/场景套件没能读取/u);
    expect(screen.getByRole("button", { name: /安装回归套件/u })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/2\/2 位/u)).toBeInTheDocument();
    expect(fixture.install).toHaveBeenCalledOnce();
  });
});
