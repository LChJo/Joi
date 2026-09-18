import { useRef, useState } from 'react';
import { ArrowSquareOutIcon, CheckIcon, DownloadSimpleIcon, FolderOpenIcon, SpinnerGapIcon, WarningCircleIcon } from '@phosphor-icons/react';
import type { DigitalLifeApi } from './api';
import type { ResultExportDto, ResultExportFormat } from '../shared/result-export';
import { randomUuid } from './random-uuid';

export function ResultExportMenu({ api, goalId, body, expanded, onExpanded }: {
  api: DigitalLifeApi; goalId: string; body: string; expanded: boolean; onExpanded: (value: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'success' | 'busy' | 'error'; detail?: string } | null>(null);
  const [saved, setSaved] = useState<ResultExportDto | null>(null);
  const running = useRef(false);
  const pending = useRef<{ format: ResultExportFormat; key: string } | null>(null);
  async function perform(format: ResultExportFormat | 'copy') {
    if (running.current || !body.trim()) return;
    running.current = true; setBusy(true); setNotice({ text: '正在处理…', tone: 'busy' }); onExpanded(false);
    try {
      if (format === 'copy') {
        await navigator.clipboard.writeText(body); setNotice({ text: '已复制全文', tone: 'success' });
      } else {
        if (pending.current?.format !== format) pending.current = { format, key: randomUuid() };
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))), b => b.toString(16).padStart(2, '0')).join('');
        let job = await api.request<ResultExportDto>('/api/v1/result-exports', { method: 'POST', body: { goalId, format, digest, idempotencyKey: pending.current.key } });
        while (job.status === 'queued' || job.status === 'rendering') {
          await new Promise(resolve => setTimeout(resolve, 800));
          job = await api.request<ResultExportDto>(`/api/v1/result-exports/${job.exportId}`);
        }
        pending.current = null;
        if (job.status !== 'completed') throw new Error('save');
        setSaved(job); setNotice({ text: `已保存 ${String(job.count)} 个文件`, detail: '下载 / Joi', tone: 'success' });
      }
    } catch (error) {
      setNotice({ text: error instanceof Error && 'code' in error && error.code === 'export_snapshot_changed' ? '正文已更新，请关闭并重新打开全文后导出。' : '操作未完成，请重试。', tone: 'error' });
    } finally { running.current = false; setBusy(false); }
  }
  async function open(reveal: boolean) {
    if (!saved) return;
    try { await api.request(`/api/v1/result-exports/${saved.exportId}/open`, { method: 'POST', body: { reveal } }); }
    catch { setNotice({ text: '文件已保存，但无法打开。请在下载/Joi 中查看。', tone: 'error' }); }
  }
  return <div className="joi-result-export" onClick={event => event.stopPropagation()}>
    {notice ? <div className="joi-export-feedback" role="group" aria-label="导出反馈">
      <div className="joi-export-feedback-message" role="status" aria-atomic="true">
        <span className={`joi-export-feedback-icon ${notice.tone}`} aria-hidden="true">
          {notice.tone === 'busy' ? <SpinnerGapIcon /> : notice.tone === 'error' ? <WarningCircleIcon /> : <CheckIcon weight="bold" />}
        </span>
        <div className="joi-export-feedback-copy"><strong>{notice.text}</strong>{notice.detail ? <span>{notice.detail}</span> : null}</div>
      </div>
      {saved ? <div className="joi-export-feedback-actions">
        <button className="button ghost" onClick={() => { void open(false); }}><ArrowSquareOutIcon aria-hidden />打开</button>
        <button className="button ghost" onClick={() => { void open(true); }}><FolderOpenIcon aria-hidden />打开目录</button>
      </div> : null}
    </div> : null}
    {expanded ? <div className="joi-export-options" role="menu">
      <button className="button ghost" role="menuitem" disabled={busy || !body.trim()} onClick={() => { void perform('copy'); }}>复制全文</button>
      {api.desktop ? <><button className="button ghost" role="menuitem" disabled={busy || !body.trim()} onClick={() => { void perform('pdf'); }}>导出 PDF</button><button className="button ghost" role="menuitem" disabled={busy || !body.trim()} onClick={() => { void perform('png'); }}>导出 PNG</button></> : null}
    </div> : null}
    <button className="button ghost icon-button" aria-label="导出全文" aria-expanded={expanded} disabled={busy || !body.trim()} onClick={() => onExpanded(!expanded)}><DownloadSimpleIcon aria-hidden /></button>
  </div>;
}
