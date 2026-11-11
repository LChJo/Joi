// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DigitalLifeApi } from "../../src/renderer/api";
import { ConsoleApp } from "../../src/renderer/Console";

it("CHAT-01 places Conversations between Joi and Workbenches and opens the blank chat surface", async () => {
  const api = new DigitalLifeApi("",true);
  vi.spyOn(api,"listInteractions").mockResolvedValue({ items: [] });
  vi.spyOn(api,"joiRuntime").mockResolvedValue({} as never);
  vi.spyOn(api,"joiSnapshot").mockResolvedValue({ workbenches: [],workbenchChanges: [],partners: [],modelSources: [],runtime: { configured: true,status: "READY" },work: [] });
  vi.spyOn(api,"joiHomeFeed").mockResolvedValue({ goals: [],thinking: [],unassignedActions: [] });
  for (const name of ["listWorkbenches","listModelSources","listPartners","listConversations"] as const) vi.spyOn(api,name).mockResolvedValue({ items: [] });
  vi.spyOn(api,"request").mockResolvedValue({ items: [] });
  render(<ConsoleApp api={api} />);
  const nav = await screen.findByRole("navigation",{ name: "主导航" });
  const buttons = within(nav).getAllByRole("button");
  expect(buttons.slice(0,3).map(button => button.textContent)).toEqual(["joi","对话","工作台"]);
  fireEvent.click(within(nav).getByRole("button",{ name: "对话" }));
  expect(await screen.findByRole("textbox",{ name: "消息" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "保留草稿" } });
  const collapse = screen.getByRole("button",{ name: "收起主导航" });
  expect(collapse).toHaveAttribute("aria-expanded","true");
  expect(collapse).toHaveTextContent("<<<");
  fireEvent.click(collapse);
  expect(screen.getByRole("button",{ name: "展开主导航" })).toHaveAttribute("aria-expanded","false");
  expect(screen.getByRole("button",{ name: "展开主导航" })).toHaveTextContent(">>>");
  expect(within(nav).getByRole("button",{ name: "对话" })).toHaveAttribute("title","对话");
  expect(screen.getByRole("textbox",{ name: "消息" })).toHaveValue("保留草稿");
  fireEvent.click(screen.getByRole("button",{ name: "展开主导航" }));
  expect(screen.getByRole("button",{ name: "收起主导航" })).toHaveAttribute("aria-expanded","true");
  expect(screen.getByRole("textbox",{ name: "消息" })).toHaveValue("保留草稿");
  const originalWidth = window.innerWidth;
  Object.defineProperty(window,"innerWidth",{ configurable: true,value: 720 });fireEvent.resize(window);
  expect(screen.getByRole("button",{ name: "展开主导航" })).toHaveTextContent(">>>");
  fireEvent.click(screen.getByRole("button",{ name: "展开主导航" }));fireEvent.resize(window);
  expect(screen.getByRole("button",{ name: "收起主导航" })).toHaveTextContent("<<<");
  Object.defineProperty(window,"innerWidth",{ configurable: true,value: originalWidth });fireEvent.resize(window);
  expect(screen.getByRole("textbox",{ name: "消息" })).toHaveValue("保留草稿");
});
