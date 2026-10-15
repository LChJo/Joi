import { t, useI18n } from "./i18n";
import joiPortrait from "./joi-avatar.png";

export function JoiBrand() {
  useI18n();
  return <header className="brand-bar" role="banner"><span className="joi-brand-avatar"><img alt="" draggable={false} height={44} src={joiPortrait} width={44} /></span><span><strong aria-label="joi" className="joi-brand-name" role="img">joi</strong><small>{t("brand.thinkPlanDelegate")}</small></span></header>;
}
