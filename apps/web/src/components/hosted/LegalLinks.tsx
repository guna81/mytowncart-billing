// SPDX-License-Identifier: Apache-2.0
/** Privacy policy, terms and grievance officer links for the hosted web app. */
import { t } from "../../i18n";
import { LEGAL_LINKS } from "../../lib/hosted/mode";

const linkCls = "text-blue-700 underline";

export function LegalLinks(props: { note?: boolean }) {
  return (
    <div className="text-xs text-gray-500 space-y-1" data-testid="hosted-legal">
      {props.note ? <p>{t("hosted.legal_note")}</p> : null}
      <p className="flex flex-wrap gap-x-3 gap-y-1">
        <a href={LEGAL_LINKS.privacy} target="_blank" rel="noopener noreferrer" className={linkCls}>
          {t("hosted.legal_privacy")}
        </a>
        <a href={LEGAL_LINKS.terms} target="_blank" rel="noopener noreferrer" className={linkCls}>
          {t("hosted.legal_terms")}
        </a>
        <a href={LEGAL_LINKS.grievance} target="_blank" rel="noopener noreferrer" className={linkCls}>
          {t("hosted.legal_grievance")}
        </a>
      </p>
    </div>
  );
}
