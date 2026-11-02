import { t, useI18n, noticeMessage, translateNotice, type MessageNotice } from "./i18n";
import { useRef, useState } from 'react';
import { ArrowSquareOutIcon, CheckIcon, DownloadSimpleIcon, FolderOpenIcon, SpinnerGapIcon, WarningCircleIcon } from '@phosphor-icons/react';
import type { DigitalLifeApi } from './api';
import type { ResultExportDto, ResultExportFormat } from '../shared/result-export';
import { randomUuid } from './random-uuid';

export function ResultExportMenu(props: {
  api: DigitalLifeApi; goalId: string; resultId?: string; body: string; expanded: boolean; onExpanded: (value: boolean) => void;
}) {
  return <SnapshotExportMenu key={JSON.stringify([props.goalId, props.resultId, props.body])} {...props} />;
}

function SnapshotExportMenu({ api, goalId, resultId, body, expanded, onExpanded }: {
  api: DigitalLifeApi; goalId: string; resultId?: string; body: string; expanded: boolean; onExpanded: (value: boolean) => void;
}) {
  useI18n();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: MessageNotice; tone: 'success' | 'busy' | 'error'; detail?: MessageNotice } | null>(null);
  const [saved, setSaved] = useState<ResultExportDto | null>(null);
  const running = useRef(false);
  const pending = useRef<{ format: ResultExportFormat; key: string } | null>(null);
  async function perform(format: ResultExportFormat | 'copy') {
    if (running.current || !body.trim()) return;
    running.current = true; setBusy(true); setNotice({ text: noticeMessage("export.processing"), tone: 'busy' }); onExpanded(false);
    try {
      if (format === 'copy') {
        await navigator.clipboard.writeText(body); setNotice({ text: noticeMessage("export.fullTextCopied"), tone: 'success' });
      } else {
        if (pending.current?.format !== format) pending.current = { format, key: randomUuid() };
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))), b => b.toString(16).padStart(2, '0')).join('');
        let job = await api.request<ResultExportDto>('/api/v1/result-exports', { method: 'POST', body: { goalId, ...(resultId === undefined ? {} : { resultId }), format, digest, idempotencyKey: pending.current.key } });
        while (job.status === 'queued' || job.status === 'rendering') {
          await new Promise(resolve => setTimeout(resolve, 800));
          job = await api.request<ResultExportDto>(`/api/v1/result-exports/${job.exportId}`);
        }
        pending.current = null;
        if (job.status !== 'completed') throw new Error('save');
        setSaved(job); setNotice({ text: noticeMessage("export.valueFilesSaved", { p0: String(job.count) }), detail: noticeMessage("export.downloadsJoi"), tone: 'success' });
      }
    } catch (error) {
      setNotice({ text: error instanceof Error && 'code' in error && error.code === 'export_snapshot_changed' ? noticeMessage("export.theContentChangedCloseAndReopenTheFullText") : noticeMessage("export.theOperationDidNotCompleteTryAgain"), tone: 'error' });
    } finally { running.current = false; setBusy(false); }
  }
  async function open(reveal: boolean) {
    if (!saved) return;
    try { await api.request(`/api/v1/result-exports/${saved.exportId}/open`, { method: 'POST', body: { reveal } }); }
    catch { setNotice({ text: noticeMessage("export.filesSavedButCouldNotBeOpenedFindThem"), tone: 'error' }); }
  }
  return <div className="joi-result-export" onClick={event => event.stopPropagation()}>
    {notice ? <div className="joi-export-feedback" role="group" aria-label={t("export.exportStatus")}>
      <div className="joi-export-feedback-message" role="status" aria-atomic="true">
        <span className={`joi-export-feedback-icon ${notice.tone}`} aria-hidden="true">
          {notice.tone === 'busy' ? <SpinnerGapIcon /> : notice.tone === 'error' ? <WarningCircleIcon /> : <CheckIcon weight="bold" />}
        </span>
        <div className="joi-export-feedback-copy"><strong>{translateNotice(notice.text)}</strong>{notice.detail ? <span>{translateNotice(notice.detail)}</span> : null}</div>
      </div>
      {saved ? <div className="joi-export-feedback-actions">
        <button className="button ghost" onClick={() => { void open(false); }}><ArrowSquareOutIcon aria-hidden />{t("common.open")}</button>
        <button className="button ghost" onClick={() => { void open(true); }}><FolderOpenIcon aria-hidden />{t("export.openFolder")}</button>
      </div> : null}
    </div> : null}
    {expanded ? <div className="joi-export-options" role="menu">
      <button className="button ghost" role="menuitem" disabled={busy || !body.trim()} onClick={() => { void perform('copy'); }}>{t("export.copyFullText")}</button>
      {api.desktop ? <><button className="button ghost" role="menuitem" disabled={busy || !body.trim()} onClick={() => { void perform('pdf'); }}>{t("export.exportPdf")}</button><button className="button ghost" role="menuitem" disabled={busy || !body.trim()} onClick={() => { void perform('png'); }}>{t("export.exportPng")}</button></> : null}
    </div> : null}
    <button className="button ghost icon-button" aria-label={t("export.exportFullText")} aria-expanded={expanded} disabled={busy || !body.trim()} onClick={() => onExpanded(!expanded)}><DownloadSimpleIcon aria-hidden /></button>
  </div>;
}
