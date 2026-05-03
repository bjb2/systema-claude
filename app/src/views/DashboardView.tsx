import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ViewProps } from "../components/ViewProps";
import HealthPanel from "../components/HealthPanel";

interface Capability {
  id: string;
  label: string;
  kind: "local-service" | "ui-native";
  description: string;
  statusPath: string;
  launchPath?: string | null;
  primaryUrl?: string | null;
}

interface CapabilityStatus {
  id: string;
  state: "available" | "running" | "missing" | "error";
  message?: string | null;
  url?: string | null;
}

export default function DashboardView({ docs, theme, orgRoot, onOpenUrl }: ViewProps) {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [capabilityStatus, setCapabilityStatus] = useState<Record<string, CapabilityStatus>>({});
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadCapabilities = async () => {
      try {
        const list = await invoke<Capability[]>("list_capabilities");
        if (cancelled) return;
        setCapabilities(list);
        const entries = await Promise.all(
          list.map(async cap => {
            try {
              const status = await invoke<CapabilityStatus>("capability_health", { id: cap.id });
              return [cap.id, status] as const;
            } catch (e: any) {
              return [cap.id, {
                id: cap.id,
                state: "error",
                message: typeof e === "string" ? e : (e?.message ?? "health check failed"),
                url: cap.primaryUrl,
              } satisfies CapabilityStatus] as const;
            }
          })
        );
        if (!cancelled) setCapabilityStatus(Object.fromEntries(entries));
      } catch (e: any) {
        if (!cancelled) setCapabilityError(typeof e === "string" ? e : (e?.message ?? "failed to load capabilities"));
      }
    };
    loadCapabilities();
    return () => { cancelled = true; };
  }, []);

  const launchCapability = async (cap: Capability) => {
    setLaunchingId(cap.id);
    setCapabilityError(null);
    try {
      const resp = await invoke<CapabilityStatus>("capability_launch", { id: cap.id });
      setCapabilityStatus(prev => ({ ...prev, [cap.id]: resp }));
      if (resp.url) onOpenUrl?.(resp.url);
    } catch (e: any) {
      setCapabilityError(typeof e === "string" ? e : (e?.message ?? "launch failed"));
    } finally {
      setLaunchingId(null);
    }
  };

  const launchableCapabilities = useMemo(
    () => capabilities.filter(cap => cap.launchPath),
    [capabilities]
  );

  const tasks = docs.filter(d => d.type === "task");
  const active = tasks.filter(d => d.status === "active");
  const blocked = tasks.filter(d => d.status === "blocked");
  const knowledge = docs.filter(d => d.type === "knowledge");
  const inbox = docs.filter(d => d.type === "inbox");
  const reminders = docs.filter(d => d.type === "reminder" && d.status === "pending");

  const stat = (label: string, value: number, color?: string) => (
    <div
      className="p-4 border rounded"
      style={{ background: theme.bgSecondary, borderColor: theme.border }}
    >
      <div className="text-2xl font-bold" style={{ color: color ?? theme.accent }}>{value}</div>
      <div className="text-xs mt-1" style={{ color: theme.textMuted }}>{label}</div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl">
        <h1 className="text-lg font-bold mb-2" style={{ color: theme.text }}>
          Dashboard
        </h1>
        <div className="text-xs mb-6 font-mono" style={{ color: theme.textDim }}>
          root: {orgRoot || "(not set)"} · {docs.length} docs loaded
        </div>

        <div className="grid grid-cols-4 gap-3 mb-8">
          {stat("active tasks", active.length, theme.accent)}
          {stat("blocked", blocked.length, theme.warning)}
          {stat("knowledge", knowledge.length)}
          {stat("inbox", inbox.length + reminders.length, inbox.length + reminders.length > 0 ? theme.warning : undefined)}
        </div>

        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 uppercase tracking-widest" style={{ color: theme.textDim }}>
            Capabilities
          </h2>
          <div className="space-y-2">
            {launchableCapabilities.map(cap => {
              const status = capabilityStatus[cap.id];
              const running = status?.state === "running";
              const disabled = launchingId === cap.id || status?.state === "missing";
              return (
                <button
                  key={cap.id}
                  onClick={() => launchCapability(cap)}
                  disabled={disabled}
                  className="w-full px-4 py-2 border rounded text-sm flex items-center gap-3 hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    background: theme.bgSecondary,
                    borderColor: theme.border,
                    color: theme.text,
                    cursor: disabled ? "default" : "pointer",
                  }}
                  title={cap.description}
                >
                  <span style={{ color: running ? theme.success : theme.accent }}>
                    {running ? "●" : "▶"}
                  </span>
                  <span>{launchingId === cap.id ? `starting ${cap.label}…` : cap.label}</span>
                  <span className="text-xs ml-auto" style={{ color: theme.textMuted }}>
                    {status?.state ?? "checking"}
                    {status?.url ? ` · ${status.url.replace(/^https?:\/\//, "")}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
          {capabilityError && (
            <div className="mt-2 text-xs font-mono" style={{ color: theme.warning }}>
              {capabilityError}
            </div>
          )}
          {Object.values(capabilityStatus).filter(status => status.message).map(status => (
            <div key={status.id} className="mt-2 text-xs font-mono" style={{ color: theme.textDim }}>
              {status.id}: {status.message}
            </div>
          ))}
        </section>

        <HealthPanel docs={docs} theme={theme} />

        {active.length > 0 && (
          <section className="mb-6">
            <h2 className="text-sm font-semibold mb-3 uppercase tracking-widest" style={{ color: theme.textDim }}>
              Active Tasks
            </h2>
            <div className="space-y-2">
              {active.map(doc => (
                <div
                  key={doc.path}
                  className="flex items-center gap-3 px-4 py-2 border rounded text-sm"
                  style={{ background: theme.bgSecondary, borderColor: theme.border }}
                >
                  <span style={{ color: theme.accent }}>▶</span>
                  <span style={{ color: theme.text }}>{doc.title}</span>
                  {doc.tags.length > 0 && (
                    <div className="ml-auto flex gap-1">
                      {doc.tags.slice(0, 3).map(t => (
                        <span key={t} className="px-1.5 py-0.5 rounded text-xs" style={{ background: theme.accentMuted, color: theme.accent }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {inbox.length > 0 && (
          <section className="mb-6">
            <h2 className="text-sm font-semibold mb-3 uppercase tracking-widest" style={{ color: theme.textDim }}>
              Inbox ({inbox.length})
            </h2>
            <div className="space-y-2">
              {inbox.map(doc => (
                <div
                  key={doc.path}
                  className="flex items-center gap-3 px-4 py-2 border rounded text-sm"
                  style={{ background: theme.bgSecondary, borderColor: theme.border }}
                >
                  <span style={{ color: theme.warning }}>◎</span>
                  <span style={{ color: theme.text }}>{doc.title}</span>
                  <span className="ml-auto text-xs" style={{ color: theme.textDim }}>{doc.created}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {reminders.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold mb-3 uppercase tracking-widest" style={{ color: theme.textDim }}>
              Pending Reminders ({reminders.length})
            </h2>
            <div className="space-y-2">
              {reminders.map(doc => (
                <div
                  key={doc.path}
                  className="flex items-center gap-3 px-4 py-2 border rounded text-sm"
                  style={{ background: theme.bgSecondary, borderColor: theme.border }}
                >
                  <span style={{ color: theme.warning }}>◷</span>
                  <span style={{ color: theme.text }}>{doc.title}</span>
                  <span className="ml-auto text-xs" style={{ color: theme.textDim }}>
                    {(doc.frontmatter["remind-at"] as string) ?? ""}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
