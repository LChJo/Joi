// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DigitalLifeApi } from '../../src/renderer/api';
import { JoiHome } from '../../src/renderer/JoiHome';
import { GoalResultHistory } from '../../src/renderer/GoalResultHistory';
import type { JoiGoalCardDto, JoiSnapshotDto } from '../../src/shared/joi';
import type { GoalResultDto, GoalResultPageDto } from '../../src/shared/goal-results';

const goal: JoiGoalCardDto = {
  agentCount: 0, canDelete: true, completionSummary: '最新结果正文', goalId: 'history-goal', status: 'COMPLETED',
  title: '历史任务', updatedAt: '2026-11-02T06:00:00Z', workbench: { workbenchId: 'history-bench', name: '历史工坊' },
  work: { active: 0, completed: 0, failed: 0, total: 0 },
};

function setup(displayedGoal = goal) {
  const api = new DigitalLifeApi('', true);
  const snapshot: JoiSnapshotDto = {
    modelSources: [], partners: [], runtime: { configured: true, status: 'READY' }, work: [], workbenchChanges: [],
    workbenches: [{ ...goal.workbench, scopeSummary: '范围', updatedAt: goal.updatedAt }],
  };
  vi.spyOn(api, 'joiSnapshot').mockResolvedValue(snapshot);
  vi.spyOn(api, 'joiHomeFeed').mockResolvedValue({ goals: [displayedGoal], thinking: [], unassignedActions: [] });
  vi.spyOn(api, 'listWorkbenchAgents').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'joiGoalDetail').mockResolvedValue({ fullTitle: goal.title, goalId: goal.goalId });
  vi.spyOn(api, 'request').mockImplementation(path => {
    if (path.endsWith('/results/earlier')) return Promise.resolve({ resultId: 'earlier', goalId: goal.goalId, completedAt: '2026-11-01T06:00:00Z', status: 'COMPLETED_WITH_GAPS', body: '# 历史正文\n\n早先交付。' });
    return Promise.resolve({ items: [
      { resultId: 'latest', completedAt: '2026-11-02T06:00:00Z', status: 'COMPLETED' },
      { resultId: 'earlier', completedAt: '2026-11-01T06:00:00Z', status: 'COMPLETED_WITH_GAPS' },
    ] });
  });
  const view = render(<JoiHome api={api} />);
  return { api, view };
}

it('opens history from the latest result and reads only the selected body in a single drawer', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: '打开「历史任务」的最终结果全文' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '历史结果' }));
  const history = await screen.findByRole('dialog', { name: '历史结果' });
  expect(await within(history).findByText('已完成（有缺口）')).toBeInTheDocument();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.click(within(history).getByRole('button', { name: /已完成（有缺口）/u }));
  expect(await within(history).findByRole('heading', { name: '历史正文' })).toBeInTheDocument();
  expect(history.querySelector('.joi-goal-result')).toHaveTextContent('历史正文 早先交付。');
  expect(within(history).queryByText('继续')).not.toBeInTheDocument();
  expect(within(history).queryByLabelText('结果产物')).not.toBeInTheDocument();
  fireEvent.click(within(history).getByRole('button', { name: '导出全文' }));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toHaveTextContent('早先交付。');
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(await within(history).findByText('最新结果')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog')).toHaveTextContent('最新结果正文');
});

it('keeps the task detail history entry available while the task runs again', async () => {
  const running: JoiGoalCardDto = { ...goal, status: 'RUNNING' };
  delete running.completionSummary;
  setup(running);
  const open = (await screen.findByText(goal.title)).closest('button');
  if (open === null) throw new Error('missing goal entry');
  fireEvent.click(open);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '历史结果' }));
  expect(await screen.findByRole('dialog', { name: '历史结果' })).toBeInTheDocument();
});

it('restores page scrolling if the whole goal view closes while history is open', async () => {
  document.body.style.overflow = 'auto';
  const { view } = setup();
  fireEvent.click(await screen.findByRole('button', { name: '打开「历史任务」的最终结果全文' }));
  fireEvent.click(screen.getByRole('button', { name: '历史结果' }));
  await screen.findByRole('dialog', { name: '历史结果' });
  view.unmount();
  expect(document.body.style.overflow).toBe('auto');
  document.body.style.overflow = '';
});

const latest: GoalResultDto = { resultId: 'latest', goalId: goal.goalId, completedAt: '2026-11-02T06:00:00Z', status: 'COMPLETED', body: '最新历史快照' };
const earlier: GoalResultDto = { resultId: 'earlier', goalId: goal.goalId, completedAt: '2026-11-01T06:00:00Z', status: 'COMPLETED_WITH_GAPS', body: '# 早先正文\n\n完整历史快照' };

function historySetup(page: GoalResultPageDto = { items: [latest, earlier] }) {
  const api = new DigitalLifeApi('', true);
  const pages = vi.spyOn(api, 'joiGoalResults').mockResolvedValue(page);
  const read = vi.spyOn(api, 'joiGoalResult').mockResolvedValue(earlier);
  const onClose = vi.fn();
  const view = render(<GoalResultHistory api={api} goal={goal} onClose={onClose} />);
  return { api, pages, read, onClose, view };
}

it('shows empty history, retries list failures without exposing private errors, and restores the page scroll lock', async () => {
  const api = new DigitalLifeApi('', true);
  const pages = vi.spyOn(api, 'joiGoalResults').mockRejectedValueOnce(new Error('private read failure')).mockResolvedValueOnce({ items: [] });
  const onClose = vi.fn();
  document.body.style.overflow = 'auto';
  const view = render(<GoalResultHistory api={api} goal={goal} onClose={onClose} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('历史结果加载失败，请重试。');
  expect(document.body.textContent).not.toContain('private read failure');
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('暂无历史结果')).toBeInTheDocument();
  expect(pages).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('presentation'));
  expect(onClose).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(document.body.style.overflow).toBe('auto');
  document.body.style.overflow = '';
});

it('loads later pages once, retries the same cursor, and restores the list position after reading', async () => {
  const { pages } = historySetup({ items: [latest], nextCursor: 'next-page' });
  await screen.findByText('最新结果');
  pages.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [latest, earlier] });
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /完成于/u })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('已完成（有缺口）')).toBeInTheDocument();
  expect(pages).toHaveBeenLastCalledWith(goal.goalId, { limit: 20, cursor: 'next-page' });
  expect(screen.getAllByRole('button', { name: /完成于/u })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
  const list = document.querySelector<HTMLDivElement>('.joi-history-list');
  if (list === null) throw new Error('missing history list');
  list.scrollTop = 360;
  fireEvent.click(screen.getByRole('button', { name: /已完成（有缺口）/u }));
  expect(await screen.findByText('完整历史快照')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '返回历史结果' }));
  expect(document.querySelector('.joi-history-list')?.scrollTop).toBe(360);
  expect(pages).toHaveBeenCalledTimes(3);
});

it.each(['pdf', 'png'])('copies and exports only the selected historical Markdown to %s', async format => {
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: vi.fn().mockResolvedValue(new Uint8Array([7]).buffer) } });
  const { api } = historySetup();
  const exportRequest = vi.spyOn(api, 'request').mockResolvedValue({ exportId: format, status: 'completed', filenames: ['result'], count: 1 });
  fireEvent.click(await screen.findByRole('button', { name: /已完成（有缺口）/u }));
  await screen.findByText('完整历史快照');
  fireEvent.click(screen.getByRole('button', { name: '导出全文' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '复制全文' }));
  await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith(earlier.body));
  fireEvent.click(screen.getByRole('button', { name: '导出全文' }));
  fireEvent.click(screen.getByRole('menuitem', { name: `导出 ${format.toUpperCase()}` }));
  await screen.findByText('已保存 1 个文件');
  expect(exportRequest.mock.calls[0]?.[1]?.body).toMatchObject({ goalId: goal.goalId, resultId: earlier.resultId, format, digest: '07' });
});

it('keeps a failed historical read retryable and suppresses unsafe Markdown content', async () => {
  const { read } = historySetup();
  const body = '<script>privateScript()</script>\n\n[安全链接](https://example.com) [本机链接](file:///private)\n\n![远程图片](https://example.com/image.png)\n\n完成正文';
  read.mockRejectedValueOnce(new Error('private snapshot failure')).mockResolvedValueOnce({ ...earlier, body });
  fireEvent.click(await screen.findByRole('button', { name: /已完成（有缺口）/u }));
  expect(await screen.findByRole('alert')).toHaveTextContent('历史结果加载失败');
  expect(screen.queryByRole('button', { name: '导出全文' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByText('完成正文');
  expect(screen.getByRole('link', { name: '安全链接' })).toHaveAttribute('href', 'https://example.com');
  expect(screen.queryByRole('link', { name: '本机链接' })).not.toBeInTheDocument();
  expect(screen.getByText('本机链接')).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/privateScript|private snapshot failure/u);
});

it('ignores a stale response after returning to the list and selecting a different result', async () => {
  const { read, onClose } = historySetup();
  let resolveEarlier: (value: GoalResultDto) => void = () => undefined;
  const pending = new Promise<GoalResultDto>(resolve => { resolveEarlier = resolve; });
  read.mockReturnValueOnce(pending).mockResolvedValueOnce(latest);
  fireEvent.click(await screen.findByRole('button', { name: /已完成（有缺口）/u }));
  expect(screen.getByRole('status')).toHaveTextContent('读取中');
  fireEvent.click(screen.getByRole('button', { name: '返回历史结果' }));
  fireEvent.click(screen.getByRole('button', { name: /最新结果/u }));
  await screen.findByText(latest.body);
  await act(async () => { resolveEarlier(earlier); await pending; });
  expect(screen.queryByText('完整历史快照')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '导出全文' }));
  fireEvent.click(screen.getByRole('presentation'));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('uses escaped goal and result identifiers and a bounded default page on the history API', async () => {
  const api = new DigitalLifeApi('');
  const request = vi.spyOn(api, 'request').mockResolvedValue({ items: [] });
  await api.joiGoalResults('g/one');
  expect(request).toHaveBeenLastCalledWith('/api/v1/joi/goals/g%2Fone/results?limit=20');
  await api.joiGoalResults('g/one', { limit: 8, cursor: 'cursor &more' });
  expect(request).toHaveBeenLastCalledWith('/api/v1/joi/goals/g%2Fone/results?limit=8&cursor=cursor+%26more');
  await api.joiGoalResult('g/one', 'result/two');
  expect(request).toHaveBeenLastCalledWith('/api/v1/joi/goals/g%2Fone/results/result%2Ftwo');
});
