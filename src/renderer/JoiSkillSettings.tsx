import { noticeMessage, t, useI18n, useNotice } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import { PuzzlePieceIcon } from "@phosphor-icons/react";
import { ApiError, type DigitalLifeApi } from "./api";

interface SkillOption { id: string; displayName: string; }

export function JoiSkillSettings({ api }: { api: DigitalLifeApi }) {
  useI18n();
  const [items, setItems] = useState<SkillOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useNotice();
  const load = useCallback(async (cancelled: () => boolean, refreshOnly = false) => {
    setLoading(true);
    try {
      const [catalog, settings] = await Promise.all([api.engineSkills("pi-core"), refreshOnly ? Promise.resolve(null) : api.settings()]);
      if (cancelled()) return;
      setItems(catalog.items);
      if (settings !== null) setSelected(settings.joiSkills ?? []);
      setLoaded(true);
      setNotice(refreshOnly ? noticeMessage("skills.skillCatalogRefreshedUnsavedSelectionsArePreserved") : null);
    } catch {
      if (!cancelled()) setNotice(noticeMessage("skills.couldNotLoadTheSkillCatalogTryAgain"));
    } finally { if (!cancelled()) setLoading(false); }
  }, [api, setNotice]);
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
      setNotice(noticeMessage("skills.skillSelectionSavedItTakesEffectOnTheNext"));
    } catch (error) {
      setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("skills.couldNotSaveTheSkillSelectionTryAgain"));
    } finally { setSaving(false); }
  };

  return <section className="joi-skill-settings"><PuzzlePieceIcon aria-hidden /><div>
    <h2>{t("skills.skillsForJoi")}</h2>
    <p>{t("skills.chooseSkillsJoiCanConsultWhenThinkingAndPlanning")}</p>
    <p className="field-hint">{t("skills.discoversSkillMdFilesInAgentsSkillsClaudeSkills")}</p>
    {notice === null ? null : <p role="status">{notice}</p>}
    <div className="row-actions"><button className="button ghost" disabled={loading || saving} onClick={() => void load(() => false, loaded)} type="button">{t("skills.refreshSkillCatalog")}</button><span>{t("skills.selected")} {selected.length}  {t("skills.items")}</span></div>
    {loading ? <p role="status">{t("skills.loadingTheSkillCatalog")}</p> : null}
    {loaded ? <>
      <label className="skill-search">{t("skills.searchSkills")}<input onChange={(event) => setQuery(event.target.value)} placeholder={t("skills.nameOrSource")} type="search" value={query} /></label>
      {invalid.length > 0 ? <div className="inline-notice warning" role="alert"><p>{t("skills.someSelectedSkillsAreUnavailableReinstallOrRemoveThem")}</p>{invalid.map((ref) => <button className="chip" disabled={saving} key={ref} onClick={() => setSelected((current) => current.filter((id) => id !== ref))} type="button">{t("home.remove2f752c")} {ref}</button>)}</div> : null}
      {items.length === 0 ? <p>{t("skills.noAvailableSkillsFoundInstallASkillAndRefresh")}</p> : visible.length === 0 ? <p>{t("skills.noMatchingSkills")}</p> : <div className="joi-skill-list">{visible.map((item) => <label className="joi-skill-option" key={item.id}>
        <input checked={selected.includes(item.id)} disabled={saving || loading} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} type="checkbox" />
        <span><strong>{item.displayName}</strong><small>{item.id}</small></span>
      </label>)}</div>}
      <button className="button quiet" disabled={saving || loading || invalid.length > 0} onClick={() => void save()} type="button">{saving ? t("settings.saving") : t("skills.saveSkillSelection")}</button>
    </> : null}
  </div></section>;
}
