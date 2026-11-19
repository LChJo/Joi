import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { UserQuestionService } from "../../src/main/application/joi/user-question-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteUserQuestionStore } from "../../src/main/infrastructure/persistence/sqlite-user-question-store.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";
import { SqlitePartnerDispatchDelivery } from "../../src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";

async function setup() {
  const fixture = await createRuntimeFixture();
  const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
  const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
  const store = new SqliteUserQuestionStore(fixture.database);
  const questions = new UserQuestionService({ store, clock: fixture.clock,
    onAnswered: async question => { await repository.applyAnsweredGoalQuestion(question.questionId); } });
  const workbench = await fixture.workbenchRegistry.create({ name: "目标队列", personaSummary: "persona", projectLabel: "joi", scopeSummary: "队列" });
  const partner = await fixture.partners.add({ capabilities: [], displayName: "测试搭档", kind: "local-pi", skills: [], tools: [] });
  const goal = await inbox.accept({ idempotencyKey: "goal-queue", text: "分别处理两份工作", workbenchId: workbench.workbenchId });
  const now = fixture.clock.now().toISOString();
  fixture.database.transaction(db => {
    db.prepare(`INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
      VALUES ('goal-turn',?,?,'session','COMPLETED',?,?)`).run(goal.inputId,workbench.workbenchId,now,now);
    db.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id,turn_id,candidate_json,policy_result_json,created_at)
      VALUES ('goal-plan','goal-turn','{}','[]',?)`).run(now);
    for (const id of ["a","b"]) {
      db.prepare(`INSERT INTO work_items (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
        VALUES (?,?,?,?,'{}','READ','WAITING',?,?)`).run(`work-${id}`,workbench.workbenchId,goal.inputId,id,now,now);
      db.prepare(`INSERT INTO dispatch_attempts (dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,status,created_at,updated_at)
        VALUES (?,'goal-plan',?,?,1,?,'WAITING_INPUT',?,?)`).run(`attempt-${id}`,`work-${id}`,partner.partnerRevisionId,`dispatch-${id}`,now,now);
      db.prepare(`INSERT INTO partner_runs (run_id,dispatch_attempt_id,action_id,workbench_id,work_id,partner_revision_id,kind,external_run_id,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'LOCAL_PI',?,'WAITING_INPUT',?,?)`).run(`run-${id}`,`attempt-${id}`,`dispatch-${id}`,workbench.workbenchId,`work-${id}`,partner.partnerRevisionId,`local:${id}`,now,now);
    }
  });
  const ask = (id: string) => repository.requireClarification(goal.inputId,"question_required",`问题 ${id}？`,{
    actionId: `action-${id}`,kind: "PARTNER_QUESTION",runId: `run-${id}`,workId: `work-${id}`,
  });
  const list = () => store.list({ kind: "GOAL",id: goal.inputId });
  const resumes = () => fixture.database.transaction(db => db.prepare("SELECT input_id,body,status FROM joi_inbox_messages WHERE goal_input_id=? AND input_id LIKE 'joi_goal_resume:goal:%'").all(goal.inputId));
  return { fixture,repository,inbox,store,questions,workbench,goal,ask,list,resumes };
}

describe("goal question queue", () => {
  it.each(["ACTIVE","ANSWERED"] as const)("ASK-04/07 cancels a %s question for individual Work and advances the gate without fabricating an answer", async state => {
    const s = await setup();
    try {
      await s.ask("a");await s.ask("b");
      const work = new SqliteWorkPlanRepository(s.fixture.database);
      const now = s.fixture.clock.now().toISOString();
      const first = (await s.list())[0];
      if (first === undefined) throw new Error("Missing active question");
      if (state === "ANSWERED") {
        await s.store.answer(first.questionId,first.version,{ text:"Unused answer",selectedOptionIds:[],source:"USER",answeredAt:now },now);
      }
      await expect(work.cancel("work-a",now)).resolves.toMatchObject({ canceled:true });
      const queue = await s.list();
      expect(queue).toMatchObject([{ status:"CANCELED",workId:"work-a" },{ status:"ACTIVE",workId:"work-b" }]);
      expect((await s.inbox.list()).find(i => i.inputId === s.goal.inputId)?.questionId).toBe(queue[1]?.questionId);
      expect(s.fixture.database.transaction(db => db.prepare("SELECT action_id,status FROM joi_user_action_requests ORDER BY action_id").all()))
        .toEqual([{ action_id:"action-a",status:"CANCELED" },{ action_id:"action-b",status:"OPEN" }]);
      expect(s.resumes()).toHaveLength(0);
      await expect(s.questions.answer(first.scope,first.questionId,{ version:first.version,text:"Stale" })).rejects.toMatchObject({ code:"question_stale" });
      await s.questions.expire();
      await expect(work.cancel("work-b",now)).resolves.toMatchObject({ canceled:true });
      expect((await s.list()).map(q => q.status)).toEqual(["CANCELED","CANCELED"]);
      const resumes = s.resumes();
      expect(resumes).toHaveLength(1);
      expect(resumes[0]).toMatchObject({ input_id:`joi_goal_resume:goal:${s.goal.inputId}:v2`,status:"PENDING" });
      expect(resumes[0]?.body).toContain("withdrawn");
      expect((await s.inbox.list()).find(i => i.inputId === s.goal.inputId)).toMatchObject({ status:"ROUTED" });
      expect(resumes[0]?.body).not.toContain("Unused answer");
    } finally { s.questions.close();await s.fixture.close(); }
  });

  it("keeps an artifact-bearing pause and durable question through a result-write failure", async () => {
    const s = await setup();
    try {
      s.fixture.database.transaction(db => {
        db.prepare("UPDATE work_items SET status='RUNNING',intent_json=? WHERE work_id='work-a'").run(JSON.stringify({ acceptanceChecks: [{ kind: "ARTIFACT_PRESENT",name: "partial.txt" }] }));
        db.prepare("UPDATE dispatch_attempts SET status='RUNNING' WHERE dispatch_attempt_id='attempt-a'").run();
        db.prepare("UPDATE partner_runs SET status='RUNNING' WHERE run_id='run-a'").run();
        db.exec("CREATE TRIGGER fail_goal_result BEFORE INSERT ON work_results BEGIN SELECT RAISE(ABORT,'result unavailable'); END;");
      });
      const verify = vi.fn(() => Promise.resolve({ status: "PASSED" as const }));
      const never = () => Promise.reject(new Error("No model or gateway should execute"));
      const delivery = new SqlitePartnerDispatchDelivery({ database: s.fixture.database,clock: s.fixture.clock,clarifications: s.repository,
        results: new SqliteWorkResultRepository(s.fixture.database),contexts: new SqliteWorkbenchContextRepository(s.fixture.database),
        partners: new SqlitePartnerRegistryRepository(s.fixture.database),contextAssembler: { assemble: never },
        gateway: { recover: never,startWithResult: never },instances: { dispatch: never },
        leases: { acquire: () => Promise.resolve(null),release: () => Promise.resolve() },verifier: { verify },
      });
      const prepared = { actionId: "dispatch-a",attemptCount: 0,dispatchAttemptId: "attempt-a",kind: "LOCAL_PI" as const,outboxId: "test",workId: "work-a" };
      const output = { kind: "terminal" as const,status: "WAITING_INPUT" as const,body: "已完成前半部分",artifacts: [{ name: "partial.txt",size: 12 }],pendingQuestion: "选哪个配置？",
        pendingQuestionSpec: { question: "选哪个配置？",options: [{ id: "a",label: "推荐配置",recommended: true }] },
      };
      await expect(delivery.complete({ prepared,output })).rejects.toThrow("result unavailable");
      expect(verify).not.toHaveBeenCalled();
      expect(await s.list()).toHaveLength(0);
      expect(s.fixture.database.transaction(db => db.prepare("SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id='attempt-a'").get())).toEqual({ status: "RUNNING" });
      s.fixture.database.transaction(db => {
        db.exec("DROP TRIGGER fail_goal_result");
        db.exec("CREATE TRIGGER fail_goal_question BEFORE INSERT ON user_questions BEGIN SELECT RAISE(ABORT,'question unavailable'); END;");
      });
      await expect(delivery.complete({ prepared,output })).rejects.toThrow("question unavailable");
      expect(s.fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS count FROM work_results").get())).toEqual({ count: 0 });
      s.fixture.database.transaction(db => db.exec("DROP TRIGGER fail_goal_question"));
      await delivery.complete({ prepared,output });
      await delivery.complete({ prepared,output });
      expect(await s.list()).toHaveLength(1);
      expect((await s.list())[0]).toMatchObject({ status: "ACTIVE",defaultOptionIds: ["a"] });
      expect(s.fixture.database.transaction(db => db.prepare("SELECT status FROM work_results WHERE run_id='run-a'").get())).toEqual({ status: "WAITING_INPUT" });
    } finally { s.questions.close(); await s.fixture.close(); }
  });

  it("keeps FIFO and one OPEN projection, then resumes once with both exact Work answers", async () => {
    const s = await setup();
    try {
      await s.ask("a"); await s.ask("b"); await s.ask("b");
      const queued = await s.list();
      expect(queued.map(q => q.status)).toEqual(["ACTIVE","QUEUED"]);
      expect(queued[1]?.expiresAt).toBeUndefined();
      expect((await s.inbox.list()).find(i => i.inputId === s.goal.inputId)?.clarificationPrompt).toBe("问题 a？");
      expect(s.fixture.database.transaction(db => db.prepare("SELECT action_id FROM joi_user_action_requests WHERE status='OPEN'").all())).toEqual([{ action_id: "action-a" }]);
      expect((await new SqliteJoiHomeFeedRepository(s.fixture.database).load(s.fixture.clock.now())).goals[0]?.questions).toHaveLength(2);
      const first = queued[0];
      if (first === undefined) throw new Error("first question missing");
      await s.inbox.clarify({ inputId: s.goal.inputId,questionId: first.questionId,questionVersion: first.version,text: "答案 A" });
      expect(s.resumes()).toEqual([]);
      expect((await s.inbox.list()).find(i => i.inputId === s.goal.inputId)).toMatchObject({ status: "CLARIFICATION_REQUIRED",clarificationPrompt: "问题 b？" });
      expect(s.fixture.database.transaction(db => db.prepare("SELECT action_id,status FROM joi_user_action_requests ORDER BY action_id").all())).toEqual([
        { action_id: "action-a",status: "RESOLVED" },{ action_id: "action-b",status: "OPEN" },
      ]);
      const second = (await s.list())[1];
      if (second === undefined) throw new Error("second question missing");
      await s.questions.answer(second.scope,second.questionId,{ version: second.version,text: "答案 B" });
      await s.repository.applyAnsweredGoalQuestion(first.questionId);
      await s.repository.applyAnsweredGoalQuestion(second.questionId);
      const resumes = s.resumes();
      expect(resumes).toHaveLength(1);
      for (const text of ["问题 a？","答案 A","action-a","work-a","问题 b？","答案 B","action-b","work-b"]) expect(resumes[0]?.body).toContain(text);
      expect((await s.list()).map(q => [q.status,q.delivery])).toEqual([["ANSWERED","DELIVERED"],["ANSWERED","DELIVERED"]]);
      const resumeId = String(resumes[0]?.input_id);
      await s.repository.createTurn({ inputId: resumeId,workbenchId: s.workbench.workbenchId,turnId: "resume-both",sessionId: "resume",createdAt: s.fixture.clock.now().toISOString() });
      await s.repository.resumeGoal({ inputId: resumeId,turnId: "resume-both" });
      const workRepository = new SqliteWorkPlanRepository(s.fixture.database);
      const work = new WorkOrchestrationService({ clock: s.fixture.clock,ids: s.fixture.ids,partners: s.fixture.partners,
        repository: workRepository,reassignment: workRepository,goalGate: workRepository,policy: { evaluate: () => Promise.resolve({ allowed: true }) },
      });
      for (const [id,answer] of [["a","答案 A"],["b","答案 B"]] as const) {
        const input = { workbenchId: s.workbench.workbenchId,turnId: "resume-both",workId: `work-${id}`,actionId: `action-${id}`,instructions: `按已确认回答继续原工作，保留原权限与验收要求：${answer}` };
        const attempt = await work.resume(input);
        expect(await work.resume(input)).toEqual(attempt);
        const brief = s.fixture.database.transaction(db => db.prepare("SELECT intent_json FROM work_items WHERE work_id=?").get(`work-${id}`));
        expect(brief?.intent_json).toContain(answer);
      }
      expect(s.fixture.database.transaction(db => db.prepare("SELECT action_id,status FROM joi_user_action_requests ORDER BY action_id").all())).toEqual([
        { action_id: "action-a",status: "APPLIED" },{ action_id: "action-b",status: "APPLIED" },
      ]);
    } finally { s.questions.close(); await s.fixture.close(); }
  });

  it("rejects a stale review after a new question and recovers callback failure without another answer", async () => {
    const s = await setup();
    try {
      await s.ask("a");
      const first = (await s.list())[0];
      if (first === undefined) throw new Error("first question missing");
      // Simulates answer persisted immediately before a host/callback failure.
      await s.store.answer(first.questionId,first.version,{ text: "答案 A",selectedOptionIds: [],source: "USER",answeredAt: s.fixture.clock.now().toISOString() },s.fixture.clock.now().toISOString());
      await s.repository.applyAnsweredGoalQuestion(first.questionId);
      const oldResume = String(s.resumes()[0]?.input_id);
      await s.repository.createTurn({ workbenchId: s.workbench.workbenchId,inputId: oldResume,turnId: "review-turn",sessionId: "review",createdAt: s.fixture.clock.now().toISOString() });
      await s.ask("b");
      await expect(s.repository.resumeGoal({ inputId: oldResume,turnId: "review-turn" })).rejects.toMatchObject({ code: "goal_resume_not_allowed" });
      s.fixture.clock.advance(30 * 60_000);
      await s.questions.expire(); await s.questions.expire();
      const second = (await s.list())[1];
      if (second === undefined) throw new Error("second question missing");
      expect(second.answer?.source).toBe("TIMEOUT_DEFAULT");
      expect(s.resumes().filter(row => row.status === "PENDING")).toHaveLength(1);
      expect(s.resumes().find(row => row.status === "PENDING")?.body).toContain("TIMEOUT_DEFAULT");
      await expect(s.repository.resumeGoal({ inputId: oldResume,turnId: "review-turn" })).rejects.toMatchObject({ code: "goal_resume_not_allowed" });
    } finally { s.questions.close(); await s.fixture.close(); }
  });

  it.each([
    ["TIMEOUT_DEFAULT", "超时自动推荐，非人工回答或授权"],
    ["USER_DEFAULT", "用户主动采用推荐答案，不构成额外权限授予或独立操作授权"],
  ] as const)("preserves %s provenance in the goal, requirements and recovery prompt", async (source, notice) => {
    const s = await setup();
    try {
      // The recovery's saved-goal preview is capped; source warnings must survive that cap.
      s.fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET body=? WHERE input_id=?").run("原始目标".repeat(1100),s.goal.inputId));
      await s.repository.requireClarification(s.goal.inputId,"question_required","如何继续？",undefined,undefined,
        { question: "如何继续？",defaultAnswer: "按推荐方案继续" });
      const question = (await s.list())[0];
      if (question === undefined) throw new Error("question missing");
      if (source === "TIMEOUT_DEFAULT") {
        s.fixture.clock.advance(30 * 60_000);
        await s.questions.expire();
      } else {
        await s.questions.answer(question.scope,question.questionId,{ version: question.version,useDefault: true });
      }
      await s.repository.applyAnsweredGoalQuestion(question.questionId);
      const goal = await s.repository.loadInput(s.goal.inputId);
      expect(goal?.body).toContain(`[${notice}]`);
      expect(goal?.body).not.toContain("[用户补充] 按推荐方案继续");
      const requirementSources = s.fixture.database.transaction(db => db.prepare(
        "SELECT body FROM joi_goal_requirement_sources WHERE goal_input_id=? ORDER BY source_revision DESC LIMIT 1").all(s.goal.inputId));
      expect(requirementSources[0]?.body).toContain(`[${notice}]`);
      expect(requirementSources[0]?.body).toContain(source);
      expect(requirementSources[0]?.body).toContain("按推荐方案继续");
      expect(s.resumes()).toHaveLength(1);
      expect(s.resumes()[0]?.body).toContain(notice);
      expect(s.resumes()[0]?.body).toContain("授权、凭据、破坏性操作、付费或发布仍需独立确认");
      expect((await s.list())[0]?.answer).toMatchObject({ source,text: "按推荐方案继续" });
    } finally { s.questions.close(); await s.fixture.close(); }
  });

  it("cancels every goal question in SQL and JSON without timeout revival", async () => {
    const s = await setup();
    try {
      await s.ask("a"); await s.ask("b");
      await s.inbox.cancel({ inputId: s.goal.inputId });
      expect((await s.list()).map(q => q.status)).toEqual(["CANCELED","CANCELED"]);
      expect(s.fixture.database.transaction(db => db.prepare("SELECT status FROM user_questions ORDER BY sequence").all())).toEqual([{ status: "CANCELED" },{ status: "CANCELED" }]);
      s.fixture.clock.advance(31 * 60_000);
      expect(await s.questions.expire()).toEqual([]); expect(s.resumes()).toEqual([]);
    } finally { s.questions.close(); await s.fixture.close(); }
  });

  it("projects queued questions on an unassigned goal without exposing internal Work bindings", async () => {
    const s = await setup();
    try {
      const unassigned = await s.inbox.accept({ idempotencyKey: "unassigned-queue",text: "先澄清范围" });
      await s.repository.requireClarification(unassigned.inputId,"question_required","先回答第一个问题");
      await s.repository.requireClarification(unassigned.inputId,"question_required","然后回答第二个问题");
      const feed = await new SqliteJoiHomeFeedRepository(s.fixture.database).load(s.fixture.clock.now());
      const questions = feed.unassignedActions.find(action => action.inputId === unassigned.inputId)?.questions;
      expect(questions?.map(question => question.status)).toEqual(["ACTIVE","QUEUED"]);
      expect(questions?.[0]?.kind).toBe("QUESTION");
      expect(questions?.[0]).not.toHaveProperty("workId");
    } finally { s.questions.close(); await s.fixture.close(); }
  });

  it.each(["canceled","finished","superseded"])("ignores a %s partner run instead of creating an authoritative question", async state => {
    const s = await setup();
    try {
      s.fixture.database.transaction(db => {
        if (state === "canceled") db.prepare("UPDATE work_items SET status='CANCELED' WHERE work_id='work-a'").run();
        if (state === "finished") db.prepare("UPDATE partner_runs SET status='COMPLETED' WHERE run_id='run-a'").run();
        if (state === "superseded") db.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,status,created_at,updated_at)
          SELECT 'new-attempt',dispatch_plan_id,work_id,partner_revision_id,registry_revision,'new-action','RUNNING','2099-01-01','2099-01-01'
            FROM dispatch_attempts WHERE dispatch_attempt_id='attempt-a'`).run();
      });
      await s.ask("a"); expect(await s.list()).toEqual([]);
    } finally { s.questions.close(); await s.fixture.close(); }
  });

  it("defers activation behind an independent choice without blocking another goal", async () => {
    const s = await setup();
    try {
      await s.repository.requireClarification(s.goal.inputId,"workbench_selection_invalid","确认工作台？");
      const choice = (await s.inbox.list()).find(input => input.inputId === s.goal.inputId);
      await s.ask("a"); await s.ask("b");
      expect((await s.list()).map(question => [question.status,question.expiresAt])).toEqual([["QUEUED",undefined],["QUEUED",undefined]]);
      s.fixture.clock.advance(31 * 60_000);
      expect(await s.questions.expire()).toEqual([]);
      const other = await s.inbox.accept({ idempotencyKey: "independent-goal",text: "另一个目标" });
      await s.repository.requireClarification(other.inputId,"question_required","另一个问题？");
      expect((await s.store.list({ kind: "GOAL",id: other.inputId }))[0]?.status).toBe("ACTIVE");
      if (choice?.questionId === undefined || choice.questionVersion === undefined) throw new Error("choice missing");
      const answeredChoice = await s.inbox.clarify({ inputId: s.goal.inputId,questionId: choice.questionId,questionVersion: choice.questionVersion,workbenchId: s.workbench.workbenchId });
      expect(answeredChoice).toMatchObject({ status: "CLARIFICATION_REQUIRED",clarificationPrompt: "问题 a？" });
      const active = (await s.list())[0];
      expect(active).toMatchObject({ status: "ACTIVE",activatedAt: s.fixture.clock.now().toISOString() });
      expect(s.resumes()).toEqual([]);
    } finally { s.questions.close(); await s.fixture.close(); }
  });

  it("keeps a newer explicit decision when an older answer callback is retried", async () => {
    const s = await setup();
    try {
      await s.ask("a");
      const first = (await s.list())[0];
      if (first === undefined) throw new Error("first question missing");
      await s.store.answer(first.questionId,first.version,{ text: "答案 A",selectedOptionIds: [],source: "USER",answeredAt: s.fixture.clock.now().toISOString() },s.fixture.clock.now().toISOString());
      await s.repository.requireClarification(s.goal.inputId,"workbench_selection_invalid","确认工作台？");
      await s.repository.applyAnsweredGoalQuestion(first.questionId);
      expect((await s.inbox.list()).find(i => i.inputId === s.goal.inputId)).toMatchObject({ status: "CLARIFICATION_REQUIRED",clarificationReasonCode: "workbench_selection_invalid" });
      expect(s.resumes()).toEqual([]);
    } finally { s.questions.close(); await s.fixture.close(); }
  });

  it("imports an old active question identity before queueing the next one", async () => {
    const s = await setup();
    try {
      await s.ask("a");
      const first = (await s.list())[0];
      if (first === undefined) throw new Error("first question missing");
      s.fixture.database.transaction(db => db.prepare("DELETE FROM user_questions").run());
      s.fixture.clock.advance(60 * 60_000);
      await s.ask("b");
      const queue = await s.list();
      expect(queue.map(q => q.status)).toEqual(["ACTIVE","QUEUED"]);
      expect(queue[0]).toMatchObject({ questionId: first.questionId,version: first.version,actionId: "action-a",activatedAt: s.fixture.clock.now().toISOString() });
      expect(await s.questions.expire()).toEqual([]);
    } finally { s.questions.close(); await s.fixture.close(); }
  });
});
