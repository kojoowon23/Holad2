export function resolveAiProxyUrl(): string {
  const importMetaEnv = (
    typeof import.meta !== "undefined"
      ? (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      : undefined
  );
  const envUrl = importMetaEnv?.VITE_AI_PROXY_URL;

  const winCfg =
    typeof window !== "undefined"
      ? (window as unknown as { __GEMINISLAND_CONFIG__?: { aiProxyUrl?: string } })
          .__GEMINISLAND_CONFIG__
      : undefined;

  let queryUrl = "";
  if (typeof location !== "undefined") {
    try {
      const p = new URLSearchParams(location.search).get("proxy")?.trim() || "";
      if (p) {
        const parsed = new URL(p);
        if (
          parsed.protocol === "https:" ||
          (parsed.protocol === "http:" &&
            (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))
        ) {
          queryUrl = parsed.origin;
        }
      }
    } catch {
      // Ignore invalid proxy query param
    }
  }

  const raw = (queryUrl || winCfg?.aiProxyUrl || envUrl || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))
    ) {
      return parsed.origin + parsed.pathname.replace(/\/+$/, "");
    }
  } catch {
    // Ignore malformed URL
  }
  return "";
}
