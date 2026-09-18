// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ResultExportMenu } from '../../src/renderer/ResultExportMenu';
import { ApiError, DigitalLifeApi } from '../../src/renderer/api';

it('copies the exact Markdown snapshot and suppresses duplicate actions', async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  const body = '# 最终结果\n\n|甲|乙|\n|-|-|\n|1|2|\n';
  render(<ResultExportMenu api={new DigitalLifeApi('', true)} goalId="goal" body={body} expanded onExpanded={vi.fn()} />);
  fireEvent.click(screen.getByRole('menuitem', { name: '复制全文' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '复制全文' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制全文'));
  expect(copy).toHaveBeenCalledExactlyOnceWith(body);
});
it('does not offer host exports to browser sessions or empty results', () => {
  render(<ResultExportMenu api={new DigitalLifeApi('')} goalId="goal" body=" " expanded onExpanded={vi.fn()} />);
  expect(screen.queryByRole('menuitem', { name: '导出 PDF' })).not.toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: '复制全文' })).toBeDisabled();
});

it.each(['pdf', 'png'])('polls %s export and offers opening and revealing saved files', async format => {
  const api = new DigitalLifeApi('', true);
  const request = vi.spyOn(api, 'request').mockResolvedValueOnce({ exportId: 'e', status: 'queued', filenames: [], count: 0 })
    .mockResolvedValueOnce({ exportId: 'e', status: 'rendering', filenames: [], count: 0 })
    .mockResolvedValueOnce({ exportId: 'e', status: 'completed', filenames: ['result'], count: 1 })
    .mockResolvedValueOnce({ opened: true }).mockRejectedValueOnce(new Error('no_viewer'));
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: vi.fn().mockResolvedValue(new Uint8Array([0, 15, 255]).buffer) } });
  const expanded = vi.fn();
  render(<ResultExportMenu api={api} goalId="g" body="body" expanded onExpanded={expanded} />);
  fireEvent.click(screen.getByRole('menuitem', { name: `导出 ${format.toUpperCase()}` }));
  expect(screen.getByRole('button', { name: '导出全文' })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存 1 个文件'), { timeout: 4000 });
  const feedback = within(screen.getByRole('group', { name: '导出反馈' }));
  expect(feedback.getByText('下载 / Joi')).toBeVisible();
  expect(feedback.getByRole('button', { name: '打开' })).toBeVisible();
  expect(feedback.getByRole('button', { name: '打开目录' })).toBeVisible();
  expect(request.mock.calls[0]?.[1]?.body).toMatchObject({ goalId: 'g', format, digest: '000fff' });
  fireEvent.click(screen.getByRole('button', { name: '打开' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/api/v1/result-exports/e/open', { method: 'POST', body: { reveal: false } }));
  fireEvent.click(screen.getByRole('button', { name: '打开目录' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('文件已保存，但无法打开'));
});

it('reuses a request key after an unconfirmed response and reports a changed snapshot', async () => {
  const api = new DigitalLifeApi('', true);
  const request = vi.spyOn(api, 'request').mockRejectedValueOnce(new Error('network'))
    .mockRejectedValueOnce(new ApiError('export_snapshot_changed', 'changed', 409))
    .mockResolvedValueOnce({ exportId: 'e', status: 'failed', filenames: [], count: 0 });
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: vi.fn().mockResolvedValue(new ArrayBuffer(0)) } });
  const expanded = vi.fn();
  render(<ResultExportMenu api={api} goalId="g" body="body" expanded onExpanded={expanded} />);
  fireEvent.click(screen.getByRole('menuitem', { name: '导出 PDF' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('操作未完成'));
  fireEvent.click(screen.getByRole('menuitem', { name: '导出 PDF' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('正文已更新'));
  expect(request.mock.calls[0]?.[1]?.body?.idempotencyKey).toBe(request.mock.calls[1]?.[1]?.body?.idempotencyKey);
  fireEvent.click(screen.getByRole('menuitem', { name: '导出 PNG' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('操作未完成'));
  fireEvent.click(screen.getByRole('button', { name: '导出全文' }));
  expect(expanded).toHaveBeenCalledWith(false);
});
