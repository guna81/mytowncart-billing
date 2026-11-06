// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { t } from "../i18n";
import { getRepository, isInTauri } from "../lib/repository";
import { lanServerStart, lanServerStatus, lanServerStop, type LanServerStatus } from "../lib/tauri";

export function LanServerPanel() {
  const isDesktop = isInTauri();

  const [status, setStatus] = useState<LanServerStatus>({
    running: false,
    port: 8080,
    urls: [],
  });
  const [portInput, setPortInput] = useState("8080");
  const [autostart, setAutostart] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load initial settings and server status
  useEffect(() => {
    if (!isDesktop) return;

    let mounted = true;

    async function loadInitial() {
      try {
        const repo = getRepository();
        const auto = await repo.getAppSetting("lan.autostart");
        const savedPort = await repo.getAppSetting("lan.port");
        if (mounted) {
          setAutostart(auto === "true" || auto === "1");
          if (savedPort && !Number.isNaN(Number(savedPort))) {
            setPortInput(savedPort);
          }
        }
        const s = await lanServerStatus();
        if (mounted) {
          setStatus(s);
          setPortInput(String(s.port));
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void loadInitial();
    return () => {
      mounted = false;
    };
  }, [isDesktop]);

  // Generate QR code whenever active URLs change
  useEffect(() => {
    const primaryUrl = status.urls[0] || (status.running ? `http://localhost:${status.port}` : null);
    if (!primaryUrl) {
      setQrCodeUrl(null);
      return;
    }

    QRCode.toDataURL(primaryUrl, {
      width: 160,
      margin: 1,
      color: {
        dark: "#1e293b",
        light: "#ffffff",
      },
    })
      .then((url) => setQrCodeUrl(url))
      .catch((err) => {
        console.error("Failed to generate LAN QR code", err);
        setQrCodeUrl(null);
      });
  }, [status.urls, status.running, status.port]);

  const handleToggleServer = async () => {
    setError(null);
    setLoading(true);
    try {
      if (status.running) {
        const s = await lanServerStop();
        setStatus(s);
      } else {
        const port = Number.parseInt(portInput, 10);
        if (Number.isNaN(port) || port < 1024 || port > 65535) {
          setError("Port must be a valid number between 1024 and 65535");
          setLoading(false);
          return;
        }
        await getRepository().setAppSetting("lan.port", String(port));
        const s = await lanServerStart(port);
        setStatus(s);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleAutostartChange = async (checked: boolean) => {
    setAutostart(checked);
    try {
      await getRepository().setAppSetting("lan.autostart", checked ? "true" : "false");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch (err) {
      console.error("Failed to copy URL", err);
    }
  };

  // If viewed from a web browser client on the LAN
  if (!isDesktop) {
    const currentUrl = typeof window !== "undefined" ? window.location.origin : "";
    return (
      <section className="rounded border border-blue-200 bg-blue-50/50 p-4 text-sm">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse" />
          <h2 className="font-semibold text-gray-800">{t("settings.lan_title")}</h2>
          <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
            Web Client
          </span>
        </div>
        <p className="text-gray-600">
          {t("settings.lan_client_notice", { url: currentUrl })}
        </p>
      </section>
    );
  }

  // Desktop settings view
  return (
    <section className="rounded border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-gray-800">{t("settings.lan_title")}</h2>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              status.running
                ? "bg-green-100 text-green-800 border border-green-300"
                : "bg-gray-100 text-gray-600 border border-gray-300"
            }`}
          >
            {status.running ? t("settings.lan_status_running") : t("settings.lan_status_stopped")}
          </span>
        </div>
      </div>

      <p className="text-sm text-gray-600 mb-4">{t("settings.lan_desc")}</p>

      {error ? (
        <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-4 mb-4">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <span>{t("settings.lan_port")}:</span>
          <input
            type="number"
            disabled={status.running || loading}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            className="w-24 rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100"
            min={1024}
            max={65535}
          />
        </label>

        <button
          type="button"
          disabled={loading}
          onClick={() => void handleToggleServer()}
          className={`rounded px-4 py-1.5 text-sm font-semibold transition-colors ${
            status.running
              ? "bg-amber-600 text-white hover:bg-amber-700"
              : "bg-blue-600 text-white hover:bg-blue-700"
          } disabled:opacity-50`}
        >
          {loading
            ? "..."
            : status.running
              ? t("settings.lan_stop")
              : t("settings.lan_start")}
        </button>

        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer ml-auto">
          <input
            type="checkbox"
            checked={autostart}
            onChange={(e) => void handleAutostartChange(e.target.checked)}
            className="rounded border-gray-300 text-blue-600"
          />
          {t("settings.lan_autostart")}
        </label>
      </div>

      {status.running && status.urls.length > 0 ? (
        <div className="mt-4 rounded border border-green-200 bg-green-50/40 p-4">
          <div className="flex flex-col md:flex-row gap-6 items-center">
            {qrCodeUrl ? (
              <div className="flex flex-col items-center">
                <img
                  src={qrCodeUrl}
                  alt="LAN Server QR Code"
                  className="rounded border border-gray-300 shadow-xs bg-white p-1"
                />
                <span className="text-[11px] text-gray-500 mt-1">Scan from phone / tablet</span>
              </div>
            ) : null}

            <div className="flex-1 space-y-3">
              <p className="text-sm font-medium text-gray-800">{t("settings.lan_scan_qr")}</p>

              <div className="space-y-2">
                {status.urls.map((url) => (
                  <div
                    key={url}
                    className="flex items-center justify-between rounded bg-white border border-gray-200 px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-blue-700 font-medium select-all">{url}</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleCopyUrl(url)}
                        className="rounded border border-gray-300 bg-gray-50 px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-100"
                      >
                        {copiedUrl === url ? t("settings.lan_copied") : t("settings.lan_copy_url")}
                      </button>
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded bg-blue-50 border border-blue-200 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                      >
                        {t("settings.lan_open_browser")}
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
