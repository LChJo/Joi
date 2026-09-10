import { useCallback, useEffect, useState } from "react";
import { PuzzlePieceIcon } from "@phosphor-icons/react";
import { ApiError, type DigitalLifeApi } from "./api";

interface SkillOption { id: string; displayName: string; }

export function JoiSkillSettings({ api }: { api: DigitalLifeApi }) {
  const [items, setItems] = useState<SkillOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async (cancelled: () => boolean, refreshOnly = false) => {
    setLoading(true);
    try {
      const [catalog, settings] = await Promise.all([api.engineSkills("pi-core"), refreshOnly ? Promise.resolve(null) : api.settings()]);
      if (cancelled()) return;
      setItems(catalog.items);
      if (settings !== null) setSelected(settings.joiSkills ?? []);
      setLoaded(true);
      setNotice(refreshOnly ? "技能目录已刷新，未保存的选择已保留。" : null);
    } catch {
      if (!cancelled()) setNotice("没能读取技能目录，请重试。");
    } finally { if (!cancelled()) setLoading(false); }
  }, [api]);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => void load(() => cancelled), 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [load]);

  const invalid = selected.filter((ref) => !items.some((item) => item.id === ref));
  const visible = items.filter((item) => `${item.displayName} ${item.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const save = async () => {
    setSaving(true);
    try {
      const settings = await api.updateSettings({ joiSkills: selected });
      setSelected(settings.joiSkills ?? []);
      setNotice("技能选择已保存，下次思考时生效。");
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "没能保存技能选择，请重试。");
    } finally { setSaving(false); }
  };

  return <section className="joi-skill-settings"><PuzzlePieceIcon aria-hidden /><div>
    <h2>主 joi 的技能</h2>
    <p>选择 joi 思考和安排工作时可以参考的技能。需要运行命令或操作外部服务时，由搭档执行。</p>
    <p className="field-hint">自动发现本机 .agents/skills、.claude/skills 和 .codex/skills 中的 SKILL.md。不勾选表示不加载；搭档的技能仍在搭档设置中单独选择。</p>
    {notice === null ? null : <p role="status">{notice}</p>}
    <div className="row-actions"><button className="button ghost" disabled={loading || saving} onClick={() => void load(() => false, loaded)} type="button">刷新技能目录</button><span>已选择 {selected.length} 个</span></div>
    {loading ? <p role="status">正在读取技能目录…</p> : null}
    {loaded ? <>
      <label className="skill-search">搜索技能<input onChange={(event) => setQuery(event.target.value)} placeholder="名称或来源" type="search" value={query} /></label>
      {invalid.length > 0 ? <div className="inline-notice warning" role="alert"><p>部分已选技能不可用，请重新安装或移除后保存。</p>{invalid.map((ref) => <button className="chip" disabled={saving} key={ref} onClick={() => setSelected((current) => current.filter((id) => id !== ref))} type="button">移除 {ref}</button>)}</div> : null}
      {items.length === 0 ? <p>还没有发现可用技能。安装 Skill 后刷新目录。</p> : visible.length === 0 ? <p>没有匹配的技能。</p> : <div className="joi-skill-list">{visible.map((item) => <label className="joi-skill-option" key={item.id}>
        <input checked={selected.includes(item.id)} disabled={saving || loading} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} type="checkbox" />
        <span><strong>{item.displayName}</strong><small>{item.id}</small></span>
      </label>)}</div>}
      <button className="button quiet" disabled={saving || loading || invalid.length > 0} onClick={() => void save()} type="button">{saving ? "保存中…" : "保存技能选择"}</button>
    </> : null}
  </div></section>;
}
