// SPDX-License-Identifier: Apache-2.0
import { t } from "../i18n";
import { DOWNLOAD_PAGE_URL, openReleasePage } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

export interface UpdateAvailableButtonProps {
  collapsed?: boolean;
  className?: string;
  label?: string;
  url?: string;
}

/**
 * Renders an accessible, styled update button when a newer release is available.
 * Clicking opens the download page in the system browser.
 * Renders nothing if no update is available.
 */
export function UpdateAvailableButton({
  collapsed = false,
  className = "",
  label,
  url = DOWNLOAD_PAGE_URL,
}: UpdateAvailableButtonProps) {
  const updateInfo = useAppStore((s) => s.updateInfo);

  if (!updateInfo) {
    return null;
  }

  const buttonTitle = t("update.available_hint");
  const buttonAria = t("update.available", { version: updateInfo.tag });
  const displayText = label ?? buttonAria;

  const handleClick = () => {
    void openReleasePage(url);
  };

  if (collapsed) {
    return (
      <button
        type="button"
        data-testid="update-available-btn"
        onClick={handleClick}
        title={buttonTitle}
        aria-label={buttonAria}
        className={`relative inline-flex items-center justify-center p-1.5 rounded-full bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors focus:outline-hidden focus:ring-2 focus:ring-amber-500 shadow-xs cursor-pointer ${className}`}
      >
        <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
        </span>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid="update-available-btn"
      onClick={handleClick}
      title={buttonTitle}
      aria-label={buttonAria}
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 hover:bg-amber-200 border border-amber-300 text-[11px] font-medium transition-colors focus:outline-hidden focus:ring-2 focus:ring-amber-500 shadow-xs cursor-pointer ${className}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
      </span>
      <span>{displayText}</span>
    </button>
  );
}
