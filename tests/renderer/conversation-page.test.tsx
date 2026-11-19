// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DigitalLifeApi } from "../../src/renderer/api";
import { ConversationPage } from "../../src/renderer/ConversationPage";
import type { ConversationDto, ConversationUpdateDto } from "../../src/shared/conversations";
import type { UserQuestionDto } from "../../src/shared/user-questions";


it("ASK-08 retains the completed SSE update when the answer refresh returns late", async () => {
  const api = new DigitalLifeApi("",true);
  const token = new Date().toISOString(), title = "Synthetic timeline";
  const question: UserQuestionDto = { scope:{kind:"CONVERSATION",id:"chat"},questionId:"q",version:1,ownerId:"turn",sourceName:"Pi",question:"Pick a route",
    kind:"QUESTION",createdAt:token,expiresAt:new Date(Date.now()+60_000).toISOString(),status:"ACTIVE",delivery:"PENDING",allowCustom:true,multiSelect:false,options:[],defaultOptionIds:[],defaultAnswer:"Route one" };
  const initial: ConversationDto = { conversationId:"chat",workbenchId:"wb",title,updatedAt:token,eventCursor:"events:chat:1",
    turns:[{ turnId:"turn",status:"RUNNING",text:"User request",createdAt:token,waitingForUser:true,questions:[question],entries:[],artifacts:[],
      config:{partnerId:"joi-chat",partnerName:"joi",networkId:"network",networkName:"Model",modelName:"Configured",skills:[],attachmentIds:[]}}] };
  const active = initial.turns[0];
  if (active === undefined) throw new Error("Missing turn fixture");
  const answered: UserQuestionDto = {...question,status:"ANSWERED",delivery:"PENDING",answer:{text:"Route one",source:"USER_DEFAULT",selectedOptionIds:[],answeredAt:token}};
  const stale: ConversationDto = {...initial,eventCursor:"events:chat:2",turns:[{...active,questions:[answered],waitingForUser:false}]};
  const refresh = Promise.withResolvers<ConversationDto>();
  const get = vi.spyOn(api,"getConversation").mockResolvedValueOnce(initial).mockImplementation(() => refresh.promise);
  let deliver: ((update: ConversationUpdateDto) => void) | undefined;
  vi.spyOn(api,"watchConversation").mockImplementation((_id,listener) => { deliver = listener;return () => undefined; });
  vi.spyOn(api,"conversationEvents").mockResolvedValue({cursor:"events:chat:1",items:[],hasMore:false});
  vi.spyOn(api,"listWorkbenches").mockResolvedValue({items:[{workbenchId:"wb",name:"Workbench",scopeSummary:"Scope",updatedAt:token}]});
  vi.spyOn(api,"listPartners").mockResolvedValue({items:[]});
  vi.spyOn(api,"listModelSources").mockResolvedValue({items:[{sourceId:"network",displayName:"Model",activeModel:{id:"configured"},status:"READY"} as never]});
  vi.spyOn(api,"listConversations").mockResolvedValue({items:[initial]});
  vi.spyOn(api,"conversationInheritance").mockResolvedValue({memoryCount:0,evolutionRevisionId:null});
  vi.spyOn(api,"request").mockResolvedValue({items:[]});
  const answer = vi.spyOn(api,"answerQuestion").mockResolvedValue(answered);
  const view = render(<ConversationPage api={api} />);
  fireEvent.click(await screen.findByRole("button",{name:title}));
  const card = await screen.findByRole("article",{name:"Pick a route"});
  const button = card.querySelector<HTMLButtonElement>("button[type=button]");
  if (button === null) throw new Error("Missing default selection button");
  fireEvent.click(button);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(answer).toHaveBeenCalledOnce();
  act(() => deliver?.({conversationId:"chat",turn:{...active,status:"COMPLETED",waitingForUser:false,questions:[{...answered,delivery:"DELIVERED"}],
    entries:[{entryId:"final",kind:"MARKDOWN",role:"AGENT",sequence:1,createdAt:token,text:"Final answer"}]}}));
  expect(screen.getByText("Final answer")).toBeInTheDocument();
  await act(async () => { refresh.resolve(stale);await refresh.promise; });
  expect(screen.getByText("Final answer")).toBeInTheDocument();
  expect(view.container.querySelector(".chat-turn-footer")).toHaveClass("status-completed");
});


it("CHAT-02/03 starts from a blank composer, selects independently, and locks the workbench after sending", async () => {
  const api = new DigitalLifeApi("",true);
  vi.spyOn(api,"listWorkbenches").mockResolvedValue({ items: [{ workbenchId: "wb",name: "项目 A",scopeSummary: "Project",updatedAt: "2026-11-11" }] });
  vi.spyOn(api,"listPartners").mockResolvedValue({ items: [] });
  vi.spyOn(api,"listModelSources").mockResolvedValue({ items: [{ sourceId: "network",displayName: "设置网络",activeModel: { id: "configured" },status: "READY" } as never] });
  const history = vi.spyOn(api,"listConversations").mockResolvedValue({ items: [] });
  vi.spyOn(api,"conversationInheritance").mockResolvedValue({ memoryCount: 0,evolutionRevisionId: null });
  vi.spyOn(api,"conversationGit").mockResolvedValue({ available: false,branch: "",branches: [],ahead: 0,behind: 0,files: [],history: [] });
  vi.spyOn(api,"conversationFiles").mockResolvedValue({ items: [] });
  vi.spyOn(api,"request").mockResolvedValue({ items: [{ id: "user/test",displayName: "Test Skill" }] });
  const send = vi.spyOn(api,"sendConversation").mockImplementation(body => Promise.resolve({ conversationId: body.conversationId,workbenchId: body.workbenchId,title: "Hello",updatedAt: "2026-11-11",context: { kind: "CHARACTERS",state: "READY",requestChars: 20,budgetChars: 100 },turns: [{ turnId: "t",text: body.text,status: "COMPLETED",createdAt: "2026-11-11",entries: [],artifacts: [],config: { partnerId: body.partnerId,partnerName: "joi",networkId: body.networkId,networkName: "设置网络",modelName: "configured",skills: body.skills,attachmentIds: [] } }] }));
  const settings = vi.fn();
  const view = render(<ConversationPage api={api} onSettings={settings} />);
  await screen.findByText("今天想一起做点什么？");
  expect(screen.queryAllByText("首次发送后，工作台不可更改")).toHaveLength(0);
  const extensions = screen.getByRole("button",{ name: "扩展" });
  fireEvent.click(extensions);
  expect(screen.getByRole("dialog",{ name: "扩展" }).textContent).toBe("扩展子代理Agent BrowserCC Safety Net");
  expect(screen.queryByRole("switch",{ name: "OpenWiki" })).not.toBeInTheDocument();
  const subagents = screen.getByRole("switch",{ name: "子代理" });
  expect(subagents).toBeChecked();
  fireEvent.click(subagents);expect(subagents).not.toBeChecked();
  for (const name of ["Agent Browser","CC Safety Net"]) expect(screen.getByRole("switch",{ name })).not.toBeChecked();
  fireEvent.click(screen.getByRole("switch",{ name: "Agent Browser" }));
  fireEvent.click(screen.getByRole("switch",{ name: "CC Safety Net" }));
  expect(extensions).toHaveTextContent("扩展 · 2");
  fireEvent.keyDown(document,{ key: "Escape" });
  expect(screen.queryByRole("dialog",{ name: "扩展" })).not.toBeInTheDocument();
  expect(extensions).toHaveFocus();
  const toolbar = view.container.querySelector(".chat-composer-toolbar");
  expect(Array.from(toolbar?.querySelectorAll(":scope > button, :scope > .chat-picker > button") ?? []).map(button => button.getAttribute("aria-label")))
    .toEqual(["附件","大模型网络","搭档","Skills","扩展","前往大模型网络设置","发送消息"]);
  expect(screen.queryByRole("button",{ name: "显示或收起工作区" })).not.toBeInTheDocument();
  expect(screen.queryByRole("separator",{ name: "调整工作区宽度" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{ name: "大模型网络" }));
  expect(screen.getByRole("option",{ name: /设置网络/ })).toBeInTheDocument();
  expect(screen.queryByRole("combobox",{ name: /模型/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("option",{ name: /设置网络/ }));
  fireEvent.click(screen.getByRole("button",{ name: "搭档" }));
  expect(screen.getByRole("option",{ name: /joi/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("option",{ name: /joi/ }));
  fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "Hello" } });
  fireEvent.click(screen.getByRole("button",{ name: "发送消息" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(view.container.querySelector(".chat-compose-area .chat-runtime-context")).toBeNull();
  expect(view.container.querySelector(".chat-output .chat-runtime-context")).toBeNull();
  expect(send.mock.calls[0]?.[0]).toMatchObject({ workbenchId: "wb",partnerId: "joi-chat",networkId: "network",text: "Hello",subagentsEnabled: false,piExtensions: ["agent-browser","cc-safety-net"] });
  expect(send.mock.calls[0]?.[0]).not.toHaveProperty("modelId");
  await waitFor(() => expect(screen.queryByRole("button",{ name: "工作台" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button",{ name: "记忆与进化 · 已继承" })).not.toBeInTheDocument();
  expect(await screen.findByRole("button",{ name: "显示或收起工作区" })).toHaveAttribute("aria-expanded","false");
  fireEvent.keyDown(window,{ key: ",",ctrlKey: true });
  expect(settings).toHaveBeenCalledTimes(1);
  const accepted = await (send.mock.results[0]?.value as Promise<ConversationDto> | undefined);
  if (accepted === undefined) throw new Error("Expected an accepted conversation.");
  history.mockResolvedValue({ items: [accepted] });vi.spyOn(api,"getConversation").mockResolvedValue(accepted);
  view.unmount();render(<ConversationPage api={api} onSettings={settings} />);
  await waitFor(() => expect(screen.queryByRole("button",{ name: "工作台" })).not.toBeInTheDocument());
  expect(screen.getByText("项目 A · 对话")).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button",{ name: "显示或收起工作区" }));
  expect(screen.getByRole("separator",{ name: "调整工作区宽度" })).toBeInTheDocument();
  expect(screen.queryAllByText("首次发送后，工作台不可更改")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button",{ name: "新建对话" }));
  expect(screen.getByRole("button",{ name: "工作台" })).toBeEnabled();
  expect(screen.getByRole("button",{ name: "记忆与进化 · 已继承" })).toBeInTheDocument();
  expect(screen.queryByRole("button",{ name: "显示或收起工作区" })).not.toBeInTheDocument();
  expect(screen.queryByRole("separator",{ name: "调整工作区宽度" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "Next conversation" } });
  fireEvent.click(screen.getByRole("button",{ name: "发送消息" }));
  expect(await screen.findByRole("button",{ name: "显示或收起工作区" })).toHaveAttribute("aria-expanded","false");
});
