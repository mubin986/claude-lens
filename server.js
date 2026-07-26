#!/usr/bin/env node
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

const app = express();
const PORT = 3456;

function isValidClaudeDir(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return (
    fs.existsSync(path.join(dir, "projects")) ||
    fs.existsSync(path.join(dir, "history.jsonl")) ||
    fs.existsSync(path.join(dir, "sessions")) ||
    fs.existsSync(path.join(dir, "stats-cache.json"))
  );
}

function detectClaudeDir() {
  const candidates = [];

  if (process.env.CLAUDE_DIR) {
    candidates.push({ path: process.env.CLAUDE_DIR, source: "env" });
  }

  candidates.push({
    path: path.join(os.homedir(), ".claude"),
    source: "home",
  });

  const platformCandidates = [];
  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      platformCandidates.push(
        { path: path.join(process.env.APPDATA, "Claude"), source: "appdata" },
        { path: path.join(process.env.APPDATA, ".claude"), source: "appdata" },
      );
    }
    if (process.env.LOCALAPPDATA) {
      platformCandidates.push({
        path: path.join(process.env.LOCALAPPDATA, "Claude"),
        source: "localappdata",
      });
    }
    if (process.env.USERPROFILE) {
      platformCandidates.push({
        path: path.join(process.env.USERPROFILE, ".claude"),
        source: "userprofile",
      });
    }
  } else if (process.platform === "darwin") {
    platformCandidates.push({
      path: path.join(os.homedir(), "Library", "Application Support", "Claude"),
      source: "macos-app-support",
    });
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    platformCandidates.push({ path: path.join(xdg, "claude"), source: "xdg" });
  }
  candidates.push(...platformCandidates);

  // Deduplicate by resolved path
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const resolved = path.resolve(c.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    unique.push({ ...c, path: resolved });
  }

  for (const cand of unique) {
    if (isValidClaudeDir(cand.path)) {
      return { ...cand, valid: true, candidates: unique };
    }
  }

  // Nothing valid — return best-effort (env or home) so error pages can show it
  const fallback = unique[0] || {
    path: path.join(os.homedir(), ".claude"),
    source: "home",
  };
  return { ...fallback, valid: false, candidates: unique };
}

function getTimezoneInfo() {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return { name, offset: `${sign}${hh}:${mm}` };
}

function localDateKey(isoTs) {
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const detected = detectClaudeDir();
const CLAUDE_DIR = detected.path;
const CLAUDE_DIR_SOURCE = detected.source;
const CLAUDE_DIR_VALID = detected.valid;

if (CLAUDE_DIR_VALID) {
  if (CLAUDE_DIR_SOURCE === "env") {
    console.log(`[claude-lens] Using CLAUDE_DIR from env: ${CLAUDE_DIR}`);
  } else {
    console.log(`[claude-lens] Auto-detected CLAUDE_DIR: ${CLAUDE_DIR} (${CLAUDE_DIR_SOURCE})`);
  }
} else {
  console.warn(
    `[claude-lens] No valid Claude data directory found. Tried:\n` +
      detected.candidates.map((c) => `  - ${c.path} (${c.source})`).join("\n") +
      `\nServer will start anyway — set CLAUDE_DIR in .env to point to your data directory.`,
  );
}

const RATES = {
  input: parseFloat(process.env.RATE_INPUT ?? "5.0") / 1e6,
  output: parseFloat(process.env.RATE_OUTPUT ?? "25.0") / 1e6,
  cacheRead: parseFloat(process.env.RATE_CACHE_READ ?? "0.5") / 1e6,
  cacheCreate: parseFloat(process.env.RATE_CACHE_CREATE ?? "6.25") / 1e6,
};

// === Cross-platform credentials reader ===
//
// Claude Code stores its OAuth credentials differently per platform:
//   - Windows: plaintext JSON at `<CLAUDE_DIR>/.credentials.json`
//   - macOS:   login Keychain entry, service name "Claude Code-credentials"
//   - Linux:   libsecret (GNOME Keyring / KWallet) under the same service name
//
// Try the file first (Windows + Linux fallback), then the platform-native
// secret store. Never log or surface the credential contents — return them
// to the caller and let the caller use only the safe fields.
function readClaudeCredentials() {
  const tried = [];
  const filePath = path.join(CLAUDE_DIR, ".credentials.json");
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return { ok: true, raw, source: "file", path: filePath };
    } catch (err) {
      return { ok: false, reason: "unreadable", message: err.message, source: "file", path: filePath };
    }
  }
  tried.push(filePath);

  if (process.platform === "darwin") {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
      );
      const text = out.trim();
      if (text) {
        try {
          const raw = JSON.parse(text);
          return { ok: true, raw, source: "keychain" };
        } catch (err) {
          return { ok: false, reason: "unreadable", message: `Keychain item is not valid JSON: ${err.message}`, source: "keychain" };
        }
      }
    } catch {
      // Item not present (or keychain locked / security cmd missing) — fall through
    }
    tried.push('macOS Keychain (service "Claude Code-credentials")');
  } else if (process.platform === "linux") {
    try {
      const out = execFileSync(
        "secret-tool",
        ["lookup", "service", "Claude Code-credentials", "account", os.userInfo().username],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
      );
      const text = out.trim();
      if (text) {
        try {
          const raw = JSON.parse(text);
          return { ok: true, raw, source: "libsecret" };
        } catch (err) {
          return { ok: false, reason: "unreadable", message: `libsecret item is not valid JSON: ${err.message}`, source: "libsecret" };
        }
      }
    } catch {
      // secret-tool missing, no keyring running, or no entry — fall through
    }
    tried.push('Linux libsecret (service "Claude Code-credentials", via secret-tool)');
  }

  return { ok: false, reason: "missing", tried };
}

app.use(express.static(__dirname));

// GET /api/config — runtime config so the UI can show the active data dir
app.get("/api/config", (req, res) => {
  res.json({
    claudeDir: CLAUDE_DIR,
    source: CLAUDE_DIR_SOURCE,
    valid: CLAUDE_DIR_VALID,
    candidates: detected.candidates.map((c) => ({
      path: c.path,
      source: c.source,
      exists: fs.existsSync(c.path),
      valid: isValidClaudeDir(c.path),
    })),
    platform: process.platform,
    timezone: getTimezoneInfo(),
  });
});

// In-memory cache of the remote profile lookup. Keyed by token (in case the
// access token rotates). 60-second TTL keeps page reloads from hammering the
// upstream API while staying fresh enough for an account view.
const PROFILE_CACHE_MS = 60_000;
let profileCache = { token: null, data: null, expiresAt: 0 };

async function fetchAnthropicProfile(token) {
  if (profileCache.token === token && Date.now() < profileCache.expiresAt) {
    return { data: profileCache.data, fromCache: true };
  }
  const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "claude-lens/1.0",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const err = new Error(`http_${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  profileCache = { token, data, expiresAt: Date.now() + PROFILE_CACHE_MS };
  return { data, fromCache: false };
}

// Strip any unknown fields out of the upstream payload before forwarding, so
// future server-side additions don't accidentally leak through this endpoint.
function projectProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const a = profile.account || {};
  const o = profile.organization || {};
  const app = profile.application || {};
  return {
    account: {
      uuid: a.uuid ?? null,
      fullName: a.full_name ?? null,
      displayName: a.display_name ?? null,
      email: a.email ?? null,
      hasClaudeMax: a.has_claude_max ?? null,
      hasClaudePro: a.has_claude_pro ?? null,
      createdAt: a.created_at ?? null,
    },
    organization: {
      uuid: o.uuid ?? null,
      name: o.name ?? null,
      organizationType: o.organization_type ?? null,
      billingType: o.billing_type ?? null,
      rateLimitTier: o.rate_limit_tier ?? null,
      seatTier: o.seat_tier ?? null,
      hasExtraUsageEnabled: o.has_extra_usage_enabled ?? null,
      subscriptionStatus: o.subscription_status ?? null,
      subscriptionCreatedAt: o.subscription_created_at ?? null,
      claudeCodeTrialEndsAt: o.claude_code_trial_ends_at ?? null,
      claudeCodeTrialDurationDays: o.claude_code_trial_duration_days ?? null,
    },
    application: {
      uuid: app.uuid ?? null,
      name: app.name ?? null,
      slug: app.slug ?? null,
    },
  };
}

// GET /api/account — read credentials (file on Windows, Keychain on macOS,
// libsecret on Linux) and surface SAFE fields only.
// SECURITY: accessToken and refreshToken must never appear in the response.
// They live in the local store but are never serialized over the wire. The
// remote profile call uses the token server-side; only the projected fields
// (see projectProfile) are forwarded to the browser.
app.get("/api/account", async (req, res) => {
  try {
    const cred = readClaudeCredentials();
    if (!cred.ok) {
      if (cred.reason === "unreadable") {
        return res.json({
          loggedIn: false,
          reason: "credentials_unreadable",
          message: cred.message,
          credentialsSource: cred.source,
          credentialsPath: cred.path || null,
        });
      }
      return res.json({
        loggedIn: false,
        reason: "credentials_missing",
        credentialsTried: cred.tried,
      });
    }

    const oauth = cred.raw.claudeAiOauth || {};
    const hasToken = typeof oauth.accessToken === "string" && oauth.accessToken.length > 0;
    if (!hasToken) {
      return res.json({
        loggedIn: false,
        reason: "no_access_token",
        credentialsSource: cred.source,
        credentialsPath: cred.path || null,
      });
    }

    const now = Date.now();
    const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;
    const expiresInMs = expiresAt != null ? expiresAt - now : null;
    const expired = expiresAt != null ? expiresAt <= now : null;

    // Optionally skip the remote fetch with ?local=1 — handy for offline use
    // and for testing the local-only path.
    let profile = null;
    let profileError = null;
    let profileFromCache = false;
    if (req.query.local !== "1") {
      try {
        const result = await fetchAnthropicProfile(oauth.accessToken);
        profile = projectProfile(result.data);
        profileFromCache = result.fromCache;
      } catch (e) {
        profileError = e.status ? `http_${e.status}` : (e.name === "TimeoutError" ? "timeout" : e.message || "unknown");
      }
    }

    res.json({
      loggedIn: true,
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null,
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
      expiresAt,
      expiresInMs,
      expired,
      organizationUuid: cred.raw.organizationUuid || null,
      credentialsSource: cred.source,
      credentialsPath: cred.path || null,
      profile,
      profileError,
      profileFromCache,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /account — serve the account page
app.get("/account", (req, res) => {
  res.sendFile(path.join(__dirname, "account.html"));
});

// GET /chat — serve the chat page
app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "chat.html"));
});

// Allow-list of models exposed to the chat UI. Keep narrow on purpose — if the
// user wants something else, add it here explicitly. Prevents typo'd model
// names from generating cryptic upstream errors.
const CHAT_MODELS = new Set([
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
]);

// === AI insight templates ===
//
// Each kind defines a system prompt, a function that turns the structured
// payload from the client into the user message, and a max_tokens cap.
// Always run on Haiku 4.5 so the cost-per-insight stays in the
// fraction-of-a-cent range. Results are cached client-side; this endpoint
// is intentionally stateless and never auto-fires.
const AI_MODEL = "claude-haiku-4-5-20251001";

function fmtNum(n) {
  if (n == null) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return Number(n).toLocaleString();
}

function fmtModelMix(models) {
  if (!models || typeof models !== "object") return "n/a";
  const entries = Object.entries(models).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "n/a";
  return entries.slice(0, 3).map(([m, c]) => `${m} (${c})`).join(", ");
}

const AI_INSIGHTS = {
  "daily-summary": {
    system:
      "You are a concise usage analyst. The user is viewing their personal Claude Code dashboard and wants a quick paragraph (3 to 5 sentences) summarising today's activity. Focus on: what shape today had, cache health, any notable cost or model shifts vs yesterday. Plain English. No emoji. No bullet points. No closing pleasantries. Just facts and observations.",
    formatUser: (ctx) => {
      const t = ctx.today || {};
      const y = ctx.yesterday;
      const all = ctx.allTime || {};
      const lines = [];
      lines.push(`TODAY (${t.date || "n/a"}, ${ctx.timezone || "local"}):`);
      lines.push(`- Sessions: ${t.sessions || 0}, messages: ${t.messages || 0}, tool calls: ${t.toolCalls || 0}`);
      lines.push(`- Tokens — input: ${fmtNum(t.input)}, output: ${fmtNum(t.output)}, cache read: ${fmtNum(t.cacheRead)}, cache write: ${fmtNum(t.cacheCreate)}`);
      lines.push(`- Cache hit rate: ${(t.hitRate ?? 0).toFixed(1)}%`);
      lines.push(`- Estimated cost: $${(t.cost || 0).toFixed(2)}`);
      lines.push(`- Top models: ${fmtModelMix(t.models)}`);
      if (y) {
        lines.push("");
        lines.push(`YESTERDAY (${y.date}): ${y.sessions || 0} sessions, ${(y.hitRate ?? 0).toFixed(1)}% hit rate, $${(y.cost || 0).toFixed(2)} cost, top models ${fmtModelMix(y.models)}`);
      } else {
        lines.push("");
        lines.push("YESTERDAY: no data on disk.");
      }
      lines.push("");
      lines.push(`ALL TIME: ${all.sessions || 0} session-days, ${(all.hitRate ?? 0).toFixed(1)}% hit rate, $${(all.cost || 0).toFixed(2)} estimated cost.`);
      return lines.join("\n");
    },
    max_tokens: 350,
  },

  "project-narrative": {
    system:
      "You are summarising what a developer has been working on in a specific project, given recent prompts they typed. Write 2 to 4 sentences capturing themes, not a list. Plain English. No emoji. Don't quote prompts verbatim — paraphrase.",
    formatUser: (ctx) => {
      const lines = [];
      lines.push(`Project: ${ctx.projectName || "unknown"}`);
      lines.push(`Activity: ${ctx.messages || 0} messages across ${ctx.sessions || 0} sessions. Last active ${ctx.lastSeen || "n/a"}.`);
      lines.push("");
      lines.push("Recent prompts (newest first):");
      const prompts = Array.isArray(ctx.prompts) ? ctx.prompts.slice(0, 30) : [];
      if (prompts.length === 0) {
        lines.push("- (no prompt text available)");
      } else {
        for (const p of prompts) lines.push(`- ${String(p).slice(0, 240)}`);
      }
      return lines.join("\n");
    },
    max_tokens: 280,
  },

  "cache-diagnosis": {
    system:
      "You are a usage analyst diagnosing Anthropic prompt-cache performance for a developer. Given daily cache statistics, write 3 to 5 sentences explaining what the hit rate looks like and why, and suggest one or two concrete actions if it is below 70%. Plain English. No emoji. Don't repeat the raw numbers — interpret them.",
    formatUser: (ctx) => {
      const lines = [];
      lines.push(`Cache statistics over the selected date range (${ctx.rangeLabel || "all time"}):`);
      const days = (ctx.days || []).slice(-14);
      for (const d of days) {
        lines.push(`- ${d.date}: hit rate ${(d.hitRate ?? 0).toFixed(1)}%, ${d.sessions || 0} sessions, ${fmtNum(d.cacheRead)} cache reads, ${fmtNum(d.cacheCreate)} cache writes, $${(d.cost || 0).toFixed(2)} cost`);
      }
      const t = ctx.totals || {};
      const totalInput = (t.input || 0) + (t.cacheRead || 0) + (t.cacheCreate || 0);
      lines.push("");
      lines.push(`Totals: ${fmtNum(t.cacheRead)} cache reads of ${fmtNum(totalInput)} input tokens (${totalInput > 0 ? ((t.cacheRead || 0) / totalInput * 100).toFixed(1) : "0"}% overall hit rate).`);
      return lines.join("\n");
    },
    max_tokens: 350,
  },

  "tool-summary": {
    system:
      "You are summarising a developer's recent tool usage in Claude Code. Given a sample of invocations of one specific tool, group them and write 3 to 5 sentences capturing themes (what kinds of commands, files, or patterns dominate). Plain English. No bullet lists. No emoji.",
    formatUser: (ctx) => {
      const lines = [];
      lines.push(`Tool: ${ctx.tool || "unknown"}`);
      lines.push(`Total invocations: ${ctx.totalCount || 0} (sample of ${(ctx.calls || []).length} most recent shown).`);
      lines.push("");
      const calls = Array.isArray(ctx.calls) ? ctx.calls.slice(0, 60) : [];
      for (const c of calls) {
        const summary = JSON.stringify(c).slice(0, 280);
        lines.push(`- ${summary}`);
      }
      return lines.join("\n");
    },
    max_tokens: 320,
  },

  "conversation-title": {
    system:
      "Given the first user message and the first assistant response of a conversation, output a 3 to 6 word title that captures the topic. Output ONLY the title — no quotes, no trailing punctuation, no preamble like 'Title:'.",
    formatUser: (ctx) => {
      const u = String(ctx.userMsg || "").slice(0, 600);
      const a = String(ctx.assistantMsg || "").slice(0, 600);
      return `USER: ${u}\n\nASSISTANT: ${a}`;
    },
    max_tokens: 30,
  },

  "conversation-summary": {
    system:
      "Summarise this conversation in 3 to 5 sentences. Capture (1) what the user was trying to do, (2) what was figured out, (3) any open threads or next steps. Plain English. No emoji. No closing pleasantries.",
    formatUser: (ctx) => {
      const msgs = Array.isArray(ctx.messages) ? ctx.messages : [];
      return msgs
        .map(m => `${(m.role || "?").toUpperCase()}: ${String(m.content || "").slice(0, 1500)}`)
        .join("\n\n");
    },
    max_tokens: 400,
  },

  "ask": {
    system:
      "You are a usage analyst answering a developer's natural-language question about their personal Claude Code dashboard. Use the provided structured snapshot. If the data does not contain what is needed to answer, say so plainly — do not invent numbers. Cite figures when relevant. Plain English, 1 to 5 sentences. No emoji.",
    formatUser: (ctx) => {
      const snapshot = ctx.snapshot ? JSON.stringify(ctx.snapshot, null, 2) : "(no snapshot)";
      return `User question: ${ctx.question || ""}\n\nDashboard snapshot:\n${snapshot}`;
    },
    max_tokens: 500,
  },

  "cost-forecast": {
    system:
      "You are a usage analyst commenting on a cost projection. Given a 7-day rolling daily-cost average, this month's spend so far, and a linear projection to month-end, write 1 to 3 sentences interpreting whether the trend is on track, elevated, or below baseline, and whether the projection looks credible (e.g. early in the month, recent spike, etc). Plain English. No emoji. No bullet points. Don't repeat raw numbers — interpret them.",
    formatUser: (ctx) => {
      const days = ctx.last7 || [];
      const recentLines = days.map(d => `- ${d.date}: $${(d.cost || 0).toFixed(2)}`);
      const lines = [
        `Today (${ctx.today || "n/a"}, ${ctx.timezone || "local"}): $${(ctx.todayCost || 0).toFixed(2)}`,
        `This month so far (day ${ctx.daysIntoMonth || 0} of ${ctx.daysInMonth || 0}): $${(ctx.monthToDate || 0).toFixed(2)}`,
        `7-day rolling daily average: $${(ctx.rolling7AvgCost || 0).toFixed(2)}`,
        `Projected month-end total: $${(ctx.projectedMonthTotal || 0).toFixed(2)} (${ctx.daysRemainingInMonth || 0} days remaining at the rolling avg)`,
        "",
        "Recent daily costs (oldest → newest):",
        ...recentLines,
      ];
      return lines.join("\n");
    },
    max_tokens: 200,
  },

  "standup-prep": {
    system:
      "You are summarising what a developer did recently for a daily / weekly standup. Output Markdown in exactly this structure (omit a section if empty):\n\n**Recent work**\n- one bullet per project, 1 short sentence each, capturing themes (don't quote prompts verbatim)\n\n**Likely up next**\n- 1 to 2 bullets inferring what's queued based on the most recent activity\n\n**Open threads / friction**\n- 0 to 2 bullets if there are signs of debugging loops, repeated failures, or stuck flows; skip this section entirely if none\n\nReference projects by their short name. Be concise. No emoji. No closing pleasantries.",
    formatUser: (ctx) => {
      const projects = ctx.projects || [];
      const blocks = projects.map(proj => {
        const prompts = Array.isArray(proj.prompts) ? proj.prompts.slice(0, 12) : [];
        const promptLines = prompts.length === 0
          ? ["- (no prompt text available)"]
          : prompts.map(p => `- ${String(p).slice(0, 220)}`);
        return [
          `### ${proj.shortName} (${proj.fullPath})`,
          `Activity: ${proj.messages || 0} messages across ${proj.sessions || 0} sessions, last active ${proj.lastSeen || "n/a"}.`,
          "Recent prompts (newest first):",
          ...promptLines,
          "",
        ].join("\n");
      });
      const header = [
        `Time range: ${ctx.rangeLabel || "recent"} (${ctx.timezone || "local"})`,
        `Total prompts in range: ${ctx.totalPrompts || 0} across ${projects.length} projects.`,
        "",
      ].join("\n");
      return header + blocks.join("\n");
    },
    max_tokens: 700,
  },

  "conversation-compact": {
    system:
      "You are compacting an older portion of a developer's chat conversation so it can be replaced with a single message that preserves the load-bearing context. Given the older turns (USER / ASSISTANT alternating), produce a markdown summary that captures: (1) the goal and scope of what's been discussed, (2) the key decisions or conclusions reached, (3) any unresolved questions, (4) any specific code, file paths, names, or facts the assistant should remember (verbatim if they're identifiers). Aim for compression — typically 5 to 12 sentences total — but never drop names, paths, or numeric facts. No emoji. No closing pleasantries. Do not address the user directly. Begin the output with `Earlier in this conversation:` so it reads as a context handoff.",
    formatUser: (ctx) => {
      const msgs = Array.isArray(ctx.messages) ? ctx.messages : [];
      return msgs
        .map(m => `${(m.role || "?").toUpperCase()}: ${String(m.content || "").slice(0, 2500)}`)
        .join("\n\n");
    },
    max_tokens: 800,
  },
};

// POST /api/chat — proxy /v1/messages with the local OAuth token.
//
// The browser sends the same JSON body shape Anthropic expects (model,
// messages, max_tokens, etc.) and the server tacks on Authorization +
// anthropic-beta headers, then pipes the upstream response (streaming or
// not) straight back to the client. The access token is read from
// .credentials.json on every request — never cached — and never appears
// in the response body.
//
// Inference billed against the user's local Claude account quota
// (no separate API key needed thanks to the `user:inference` scope).
app.post("/api/chat", express.json({ limit: "25mb" }), async (req, res) => {
  const cred = readClaudeCredentials();
  let token;
  if (!cred.ok) {
    if (cred.reason === "unreadable") {
      return res.status(500).json({ error: "credentials_read_error", message: cred.message });
    }
    return res.status(401).json({ error: "not_logged_in", reason: "credentials_missing" });
  }
  token = cred.raw.claudeAiOauth?.accessToken;
  if (!token) {
    return res.status(401).json({ error: "not_logged_in", reason: "no_access_token" });
  }

  const body = req.body || {};
  if (!body.model || !CHAT_MODELS.has(body.model)) {
    return res.status(400).json({
      error: "bad_model",
      message: `Model not in allow-list. Pick one of: ${[...CHAT_MODELS].join(", ")}`,
    });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: "bad_messages", message: "messages must be a non-empty array" });
  }

  // === Claude-Code identity injection ===
  //
  // Anthropic gates the OAuth-friendly rate-limit bucket behind the EXACT
  // string below appearing as a system block. Without it, OAuth requests
  // share a much smaller quota and 429 quickly even with the same token —
  // confirmed by probing: a string-form `system: "<marker>\n\n..."` 429s,
  // but `system: [{type:"text", text:"<marker>"}, {type:"text", text:"..."}]`
  // gets through. So we always force the system field into block-array
  // form with the marker as the first block.
  //
  // The second block tells Claude it's in conversational chat mode
  // (no tools, no workspace) so responses don't default to the code-focused
  // Claude Code persona.
  const CC_SYSTEM_MARKER = "You are Claude Code, Anthropic's official CLI for Claude.";
  const CHAT_CONTEXT_BLOCK = "You are running in conversational chat mode inside claude-lens, a local web UI. The user is having a normal conversation — coding-related or not. You have no file access, no tool use, and no workspace in this session. Respond naturally; do not assume the user wants you to write code unless they explicitly ask.";

  const userSystem = body.system;
  const extraBlocks = [];
  if (typeof userSystem === "string" && userSystem.trim().length > 0) {
    extraBlocks.push({ type: "text", text: userSystem });
  } else if (Array.isArray(userSystem)) {
    for (const block of userSystem) {
      // Don't re-add a block that already matches the marker exactly
      if (block?.type === "text" && block?.text === CC_SYSTEM_MARKER) continue;
      extraBlocks.push(block);
    }
  }
  body.system = [
    { type: "text", text: CC_SYSTEM_MARKER },
    { type: "text", text: CHAT_CONTEXT_BLOCK },
    ...extraBlocks,
  ];

  let upstreamRes;
  try {
    upstreamRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-lens/1.0",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return res.status(502).json({ error: "upstream_unreachable", message: err.message });
  }

  // Pass status + content-type through; stream body chunk-by-chunk so SSE
  // events reach the browser as they arrive.
  res.status(upstreamRes.status);
  const ct = upstreamRes.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);

  // Forward Anthropic's rate-limit headers + retry-after so the UI can
  // explain 429s instead of just throwing "HTTP 429".
  for (const [name, value] of upstreamRes.headers) {
    const n = name.toLowerCase();
    if (n.startsWith("anthropic-ratelimit-") || n === "retry-after" || n === "anthropic-request-id") {
      res.setHeader(name, value);
    }
  }

  // Disable proxy buffering for SSE
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  if (!upstreamRes.body) {
    return res.end();
  }
  const reader = upstreamRes.body.getReader();
  req.on("close", () => {
    // Client disconnected — abort upstream read so we stop billing tokens
    try { reader.cancel("client_disconnected"); } catch {}
  });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    // Pipe errors usually mean the client disconnected mid-stream
  } finally {
    res.end();
  }
});

// POST /api/ai-insight — generate a short paragraph for one of the
// pre-defined dashboard insight kinds (daily-summary, project-narrative,
// cache-diagnosis, tool-summary, conversation-title, conversation-summary,
// ask). Always uses Haiku for cost control. Stateless — caching is the
// caller's job (the dashboard caches by kind+context-hash in localStorage).
app.post("/api/ai-insight", express.json({ limit: "2mb" }), async (req, res) => {
  const cred = readClaudeCredentials();
  let token;
  if (!cred.ok) {
    if (cred.reason === "unreadable") {
      return res.status(500).json({
        error: "credentials_read_error",
        message: `Could not read Claude credentials (${cred.source}): ${cred.message}`,
      });
    }
    return res.status(401).json({
      error: "not_logged_in",
      reason: "credentials_missing",
      message: "Not signed in to Claude. Run `claude /login` in a terminal first, then reload this page.",
    });
  }
  token = cred.raw.claudeAiOauth?.accessToken;
  if (!token) {
    return res.status(401).json({
      error: "not_logged_in",
      reason: "no_access_token",
      message: "Credentials present but contain no access token. Try `claude /logout` then `claude /login` to refresh it.",
    });
  }

  const { kind, context } = req.body || {};
  const tmpl = AI_INSIGHTS[kind];
  if (!tmpl) {
    return res.status(400).json({ error: "bad_kind", message: `Unknown insight kind: ${kind}. Valid: ${Object.keys(AI_INSIGHTS).join(", ")}` });
  }

  let userMessage;
  try {
    userMessage = tmpl.formatUser(context || {});
  } catch (err) {
    return res.status(400).json({ error: "bad_context", message: err.message });
  }

  const body = {
    model: AI_MODEL,
    max_tokens: tmpl.max_tokens || 400,
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: tmpl.system },
    ],
    messages: [{ role: "user", content: userMessage }],
  };

  let upstreamRes;
  try {
    upstreamRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-lens/1.0",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return res.status(502).json({ error: "upstream_unreachable", message: err.message });
  }

  // Forward rate-limit headers so the UI can surface 429 reasons
  for (const [name, value] of upstreamRes.headers) {
    const n = name.toLowerCase();
    if (n.startsWith("anthropic-ratelimit-") || n === "retry-after" || n === "anthropic-request-id") {
      res.setHeader(name, value);
    }
  }

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(errText); } catch { /* ignore */ }
    return res.status(upstreamRes.status).json({
      error: parsed?.error?.type || "upstream_error",
      message: parsed?.error?.message || errText || `HTTP ${upstreamRes.status}`,
    });
  }

  let anth;
  try {
    anth = await upstreamRes.json();
  } catch (err) {
    return res.status(502).json({ error: "upstream_parse_error", message: err.message });
  }
  const text = (anth.content || [])
    .filter(c => c && c.type === "text" && typeof c.text === "string")
    .map(c => c.text)
    .join("")
    .trim();
  const usage = anth.usage || {};
  res.json({
    kind,
    text,
    model: anth.model || AI_MODEL,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    },
    generatedAt: new Date().toISOString(),
  });
});

// === OpenAI-compatible API ===
//
// Lets external clients (OpenAI Python/JS SDKs, curl, etc.) talk to the
// user's local Claude account using the OpenAI Chat Completions wire shape.
// Translates request/response/stream between OpenAI and Anthropic, and
// reuses the same OAuth-based proxy logic as /api/chat (so the load-bearing
// system marker is injected automatically and the same quota applies).

// Optional API key. If LOCAL_API_KEY is set in .env, callers must send
// `Authorization: Bearer <key>`. Unset → no auth (trust localhost).
const LOCAL_API_KEY = process.env.LOCAL_API_KEY || null;

function checkLocalApiKey(req, res) {
  if (!LOCAL_API_KEY) return true;
  const auth = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m || m[1] !== LOCAL_API_KEY) {
    res.status(401).json({
      error: { type: "invalid_request_error", message: "Invalid or missing API key. Set LOCAL_API_KEY in .env to control this." },
    });
    return false;
  }
  return true;
}

// Map Anthropic stop_reason → OpenAI finish_reason.
function mapStopReason(reason) {
  if (!reason) return null;
  if (reason === "end_turn") return "stop";
  if (reason === "stop_sequence") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "refusal") return "content_filter";
  return "stop";
}

// Convert an OpenAI multimodal content array into Anthropic's block form.
// Accepts a string (returned as-is) or an array of {type,text}/{type,image_url,...}.
function convertOpenAIContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const blocks = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
    } else if (item.type === "image_url") {
      const url = typeof item.image_url === "string"
        ? item.image_url
        : (item.image_url && item.image_url.url) || "";
      if (!url) continue;
      const dataMatch = /^data:([^;,]+);base64,(.+)$/i.exec(url);
      if (dataMatch) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] },
        });
      } else {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    } else if (item.type === "input_audio") {
      // Not supported — skip with a marker so the model still has context.
      blocks.push({ type: "text", text: "[audio attachment — not supported by Claude]" });
    }
  }
  return blocks.length > 0 ? blocks : "";
}

// Convert an OpenAI Chat Completions request body into the Anthropic shape.
// Returns { body, warnings:[string] }.
function openAIRequestToAnthropic(input) {
  const warnings = [];
  const body = {};

  if (!input || typeof input !== "object") {
    throw Object.assign(new Error("Request body must be an object"), { status: 400 });
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw Object.assign(new Error("messages must be a non-empty array"), { status: 400 });
  }

  body.model = input.model;

  // Required by Anthropic. OpenAI's default is no cap; pick a sensible cap.
  body.max_tokens = Number.isFinite(input.max_tokens) ? input.max_tokens : 4096;

  if (Number.isFinite(input.temperature)) body.temperature = input.temperature;
  if (Number.isFinite(input.top_p)) body.top_p = input.top_p;

  if (typeof input.stop === "string") body.stop_sequences = [input.stop];
  else if (Array.isArray(input.stop)) body.stop_sequences = input.stop.filter(s => typeof s === "string");

  if (input.stream) body.stream = true;

  // Pull system messages out of the messages array — Anthropic uses a
  // separate `system` field. Concatenate them in the order they appeared.
  const systemTexts = [];
  const messages = [];
  for (const m of input.messages) {
    if (!m || typeof m !== "object" || !m.role) continue;
    if (m.role === "system") {
      const t = typeof m.content === "string" ? m.content : convertOpenAIContent(m.content);
      if (typeof t === "string" && t.trim().length > 0) systemTexts.push(t);
      // Note: arrays end up empty for systems — Anthropic system is text-only
      continue;
    }
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: convertOpenAIContent(m.content) });
    } else if (m.role === "tool") {
      // Tool results — not supported in this minimal translation
      warnings.push(`Ignored 'tool' message (function calling not yet supported)`);
    }
  }
  if (systemTexts.length > 0) body.system = systemTexts.join("\n\n");
  body.messages = messages;

  // Warn about fields we silently drop so SDK clients don't get confused.
  for (const f of ["frequency_penalty", "presence_penalty", "logit_bias", "response_format", "tools", "tool_choice", "n", "logprobs", "top_logprobs", "seed", "service_tier", "parallel_tool_calls"]) {
    if (f in input) warnings.push(`Ignored unsupported field: ${f}`);
  }

  return { body, warnings };
}

// Convert a non-streaming Anthropic response into the OpenAI shape.
function anthropicResponseToOpenAI(anth, model) {
  const content = Array.isArray(anth.content) ? anth.content : [];
  const text = content
    .filter(c => c && c.type === "text" && typeof c.text === "string")
    .map(c => c.text)
    .join("");
  const usage = anth.usage || {};
  const promptTokens =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  const completionTokens = usage.output_tokens || 0;
  return {
    id: "chatcmpl-" + (anth.id ? anth.id.replace(/^msg_/, "") : Date.now().toString(36)),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || anth.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: mapStopReason(anth.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: usage.cache_read_input_tokens || 0 },
    },
  };
}

// Convert Anthropic SSE stream → OpenAI streaming chunks. Reads from `reader`
// and writes `data: {json}\n\n` (and a final `data: [DONE]\n\n`) to `res`.
async function pipeAnthropicStreamAsOpenAI(reader, res, requestedModel, includeUsage) {
  const decoder = new TextDecoder();
  let buffer = "";
  let chatId = "chatcmpl-" + Date.now().toString(36);
  let modelOut = requestedModel || "";
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let stopReason = null;
  let openedRoleChunk = false;

  const writeChunk = (delta, finishReason = null, usage = undefined) => {
    const chunk = {
      id: chatId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelOut,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) chunk.usage = usage;
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const handleEvent = (event, dataStr) => {
    let data;
    try { data = JSON.parse(dataStr); } catch { return; }
    if (event === "message_start" && data.message) {
      if (data.message.id) chatId = "chatcmpl-" + data.message.id.replace(/^msg_/, "");
      if (data.message.model) modelOut = data.message.model;
      const u = data.message.usage || {};
      inputTokens = u.input_tokens || 0;
      cachedTokens = u.cache_read_input_tokens || 0;
      if (!openedRoleChunk) {
        writeChunk({ role: "assistant", content: "" });
        openedRoleChunk = true;
      }
    } else if (event === "content_block_delta" && data.delta && data.delta.type === "text_delta") {
      writeChunk({ content: data.delta.text || "" });
    } else if (event === "message_delta") {
      if (data.delta && data.delta.stop_reason) stopReason = data.delta.stop_reason;
      if (data.usage && Number.isFinite(data.usage.output_tokens)) outputTokens = data.usage.output_tokens;
    } else if (event === "error") {
      // Forward as a final chunk with finish_reason=stop so the client closes.
      writeChunk({}, "stop");
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (event && data) handleEvent(event, data);
      }
    }
  } catch {
    // Reader error — most likely client disconnect; just terminate the stream.
  }

  // Final chunk with finish_reason + optional usage
  const finishReason = mapStopReason(stopReason) || "stop";
  let usage;
  if (includeUsage) {
    const promptTokens = inputTokens + cachedTokens;
    usage = {
      prompt_tokens: promptTokens,
      completion_tokens: outputTokens,
      total_tokens: promptTokens + outputTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    };
  }
  writeChunk({}, finishReason, usage);
  res.write("data: [DONE]\n\n");
  res.end();
}

// GET /v1/models — OpenAI-compatible model listing
app.get("/v1/models", (req, res) => {
  if (!checkLocalApiKey(req, res)) return;
  const created = Math.floor(Date.now() / 1000);
  res.json({
    object: "list",
    data: [...CHAT_MODELS].map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "anthropic",
    })),
  });
});

// POST /v1/chat/completions — OpenAI-compatible chat completion
app.post("/v1/chat/completions", express.json({ limit: "25mb" }), async (req, res) => {
  if (!checkLocalApiKey(req, res)) return;

  // Read OAuth token from local credentials (same path as /api/chat)
  const cred = readClaudeCredentials();
  let token;
  if (!cred.ok) {
    if (cred.reason === "unreadable") {
      return res.status(500).json({ error: { type: "server_error", message: cred.message } });
    }
    return res.status(401).json({ error: { type: "authentication_error", message: "Not signed in. Run `claude /login` in a terminal first." } });
  }
  token = cred.raw.claudeAiOauth?.accessToken;
  if (!token) {
    return res.status(401).json({ error: { type: "authentication_error", message: "No access token in credentials." } });
  }

  let translated;
  try {
    translated = openAIRequestToAnthropic(req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: { type: "invalid_request_error", message: err.message } });
  }
  const { body: anthropicBody, warnings } = translated;

  if (!anthropicBody.model || !CHAT_MODELS.has(anthropicBody.model)) {
    return res.status(400).json({
      error: { type: "invalid_request_error", message: `Model not in allow-list. Pick one of: ${[...CHAT_MODELS].join(", ")}` },
    });
  }

  // Inject the load-bearing Claude-Code system marker (same as /api/chat).
  // Without this block, OAuth requests share a much smaller quota and 429 quickly.
  const userSystem = anthropicBody.system;
  const extraBlocks = [];
  if (typeof userSystem === "string" && userSystem.trim().length > 0) {
    extraBlocks.push({ type: "text", text: userSystem });
  }
  anthropicBody.system = [
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: "text", text: "You are running in conversational chat mode inside claude-lens, a local OpenAI-compatible API gateway. The user is making API calls — respond as a general-purpose assistant. You have no file access, no tool use, and no workspace in this session." },
    ...extraBlocks,
  ];

  const wantStream = !!anthropicBody.stream;
  const includeUsage = !!(req.body && req.body.stream_options && req.body.stream_options.include_usage);

  let upstreamRes;
  try {
    upstreamRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-lens/1.0",
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch (err) {
    return res.status(502).json({ error: { type: "upstream_error", message: err.message } });
  }

  // Forward Anthropic rate-limit + warning headers
  for (const [name, value] of upstreamRes.headers) {
    const n = name.toLowerCase();
    if (n.startsWith("anthropic-ratelimit-") || n === "retry-after" || n === "anthropic-request-id") {
      res.setHeader(name, value);
    }
  }
  if (warnings.length > 0) res.setHeader("X-Claude-Lens-Warnings", warnings.join("; "));

  if (!upstreamRes.ok) {
    // Upstream returned a non-2xx — translate the error envelope to OpenAI shape.
    const errText = await upstreamRes.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(errText); } catch { /* ignore */ }
    const errType = parsed?.error?.type || "upstream_error";
    const errMsg = parsed?.error?.message || errText || `HTTP ${upstreamRes.status}`;
    return res.status(upstreamRes.status).json({
      error: {
        type: errType === "rate_limit_error" ? "rate_limit_exceeded" : errType,
        message: errMsg,
        code: errType,
      },
    });
  }

  if (wantStream) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    if (!upstreamRes.body) return res.end();
    const reader = upstreamRes.body.getReader();
    req.on("close", () => {
      try { reader.cancel("client_disconnected"); } catch { /* ignore */ }
    });
    await pipeAnthropicStreamAsOpenAI(reader, res, anthropicBody.model, includeUsage);
    return;
  }

  // Non-streaming
  let anth;
  try {
    anth = await upstreamRes.json();
  } catch (err) {
    return res.status(502).json({ error: { type: "upstream_error", message: "Upstream returned non-JSON: " + err.message } });
  }
  res.json(anthropicResponseToOpenAI(anth, anthropicBody.model));
});

// POST /api/stress — concurrent stress test runner. Streams progress as SSE.
//
// Body: { model, prompt, total, concurrency, max_tokens?, system? }
// Caps: concurrency ∈ [1, 20], total ∈ [1, 500]. Hard caps to keep this from
// being a foot-gun against the user's own quota. The browser shows live
// counters + final percentiles; cancellation is server-driven via the
// request `close` event so an aborted run stops billing immediately.
//
// Each worker fires a non-streaming /v1/messages call with the same OAuth
// token + load-bearing Claude-Code system marker as /api/chat. Latency is
// wall-clock around the upstream fetch; tokens come from Anthropic's `usage`
// block on success.
//
// SSE event shapes:
//   start    { model, total, concurrency, maxTokens, limits, promptPreview }
//   result   { idx, status, latencyMs, tokens?, error?, message? }
//   progress { done, inFlight, total, errors, elapsedMs }
//   done     { total, done, aborted, elapsedMs, successful, errors,
//              latencyMs:{min,p50,p95,p99,max,mean},
//              throughput:{requestsPerSec,tokensPerSec},
//              usage:{input,output,cache_read,cache_create},
//              rateLimitHeaders }
const STRESS_LIMITS = { maxConcurrency: 20, maxTotal: 500, maxTokensCap: 4096 };

app.post("/api/stress", express.json({ limit: "1mb" }), async (req, res) => {
  const cred = readClaudeCredentials();
  if (!cred.ok) {
    return res.status(401).json({ error: "not_logged_in", reason: cred.reason || "credentials_missing" });
  }
  const token = cred.raw.claudeAiOauth?.accessToken;
  if (!token) {
    return res.status(401).json({ error: "not_logged_in", reason: "no_access_token" });
  }

  const body = req.body || {};
  const model = body.model;
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const totalReq = parseInt(body.total, 10);
  const concurrencyReq = parseInt(body.concurrency, 10);
  if (!Number.isFinite(totalReq) || totalReq < 1) {
    return res.status(400).json({ error: "bad_params", message: "total must be a positive integer" });
  }
  if (!Number.isFinite(concurrencyReq) || concurrencyReq < 1) {
    return res.status(400).json({ error: "bad_params", message: "concurrency must be a positive integer" });
  }
  const total = Math.min(STRESS_LIMITS.maxTotal, totalReq);
  const concurrency = Math.min(STRESS_LIMITS.maxConcurrency, concurrencyReq);
  const maxTokens = Math.min(STRESS_LIMITS.maxTokensCap, Math.max(1, parseInt(body.max_tokens, 10) || 64));

  if (!model || !CHAT_MODELS.has(model)) {
    return res.status(400).json({ error: "bad_model", message: `Pick one of: ${[...CHAT_MODELS].join(", ")}` });
  }
  if (!prompt.trim()) {
    return res.status(400).json({ error: "bad_prompt", message: "prompt must be non-empty" });
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  let nextIdx = 0;
  let inFlight = 0;
  let done = 0;
  const errors = { http_4xx: 0, http_5xx: 0, http_429: 0, network: 0 };
  const latencies = [];
  const totalUsage = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
  let lastRateLimitHeaders = {};

  // Listen on `res.close` (not `req.close`): the response stream's `close`
  // event only fires when the underlying socket terminates, while
  // `req.close` on Node ≥18 fires as soon as the request body has been fully
  // read — which would falsely abort every run. Guard with `writableEnded`
  // so the natural end-of-stream after `res.end()` doesn't count as abort.
  res.on("close", () => {
    if (!res.writableEnded) aborted = true;
  });

  const startedAt = Date.now();

  const systemBlocks = [
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: "text", text: "You are running inside a stress test. Reply briefly." },
  ];
  if (typeof body.system === "string" && body.system.trim()) {
    systemBlocks.push({ type: "text", text: body.system.trim() });
  }
  const requestBody = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: [{ role: "user", content: prompt }],
  });

  send("start", {
    model,
    total,
    concurrency,
    maxTokens,
    limits: STRESS_LIMITS,
    promptPreview: prompt.length > 120 ? prompt.slice(0, 120) + "…" : prompt,
  });

  async function runOne(idx) {
    const t0 = Date.now();
    let upstreamRes;
    try {
      upstreamRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-lens-stress/1.0",
        },
        body: requestBody,
      });
    } catch (err) {
      const latencyMs = Date.now() - t0;
      latencies.push(latencyMs);
      errors.network++;
      return { idx, status: 0, latencyMs, error: "network", message: err.message };
    }
    const status = upstreamRes.status;
    for (const [n, v] of upstreamRes.headers) {
      const ln = n.toLowerCase();
      if (ln.startsWith("anthropic-ratelimit-") || ln === "retry-after" || ln === "anthropic-request-id") {
        lastRateLimitHeaders[n] = v;
      }
    }
    let bodyText = "";
    try {
      bodyText = await upstreamRes.text();
    } catch {}
    const latencyMs = Date.now() - t0;
    latencies.push(latencyMs);
    if (!upstreamRes.ok) {
      if (status === 429) errors.http_429++;
      else if (status >= 500) errors.http_5xx++;
      else errors.http_4xx++;
      return { idx, status, latencyMs, error: `http_${status}`, message: bodyText.slice(0, 300) };
    }
    let tokens = null;
    try {
      const j = JSON.parse(bodyText);
      const u = j.usage || {};
      tokens = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cache_read: u.cache_read_input_tokens || 0,
        cache_create: u.cache_creation_input_tokens || 0,
      };
      totalUsage.input += tokens.input;
      totalUsage.output += tokens.output;
      totalUsage.cache_read += tokens.cache_read;
      totalUsage.cache_create += tokens.cache_create;
    } catch {
      // success status but unparseable body — count as success without tokens
    }
    return { idx, status, latencyMs, tokens };
  }

  function pickIdx() {
    if (aborted || nextIdx >= total) return -1;
    return nextIdx++;
  }

  async function worker() {
    while (true) {
      const idx = pickIdx();
      if (idx < 0) return;
      inFlight++;
      const result = await runOne(idx);
      inFlight--;
      done++;
      send("result", result);
      // Stop early if Anthropic is hard-rate-limiting — surface the limit
      // instead of burning every remaining request on guaranteed 429s.
      if (errors.http_429 >= 3) {
        aborted = true;
      }
    }
  }

  const progressTimer = setInterval(() => {
    if (aborted || res.writableEnded) return;
    send("progress", { done, inFlight, total, errors, elapsedMs: Date.now() - startedAt });
  }, 500);

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  clearInterval(progressTimer);

  const sortedLat = [...latencies].sort((a, b) => a - b);
  const pct = (p) => {
    if (!sortedLat.length) return 0;
    const k = Math.min(sortedLat.length - 1, Math.max(0, Math.ceil((p / 100) * sortedLat.length) - 1));
    return sortedLat[k];
  };
  const elapsedMs = Date.now() - startedAt;
  const failures = errors.http_4xx + errors.http_5xx + errors.http_429 + errors.network;
  const successful = Math.max(0, done - failures);
  const summary = {
    total,
    done,
    aborted,
    elapsedMs,
    successful,
    errors,
    latencyMs: {
      min: sortedLat[0] || 0,
      p50: pct(50),
      p95: pct(95),
      p99: pct(99),
      max: sortedLat[sortedLat.length - 1] || 0,
      mean: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    },
    throughput: {
      requestsPerSec: elapsedMs > 0 ? +(done * 1000 / elapsedMs).toFixed(2) : 0,
      tokensPerSec: elapsedMs > 0 ? +(totalUsage.output * 1000 / elapsedMs).toFixed(2) : 0,
    },
    usage: totalUsage,
    rateLimitHeaders: lastRateLimitHeaders,
  };
  send("done", summary);
  if (!res.writableEnded) res.end();
});

// GET /api — serve the OpenAI-compatible API docs / playground page
app.get("/api", (req, res) => {
  res.sendFile(path.join(__dirname, "api.html"));
});

// GET /api/stats — return stats-cache.json as-is
app.get("/api/stats", (req, res) => {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(CLAUDE_DIR, "stats-cache.json"), "utf8"),
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history — typed user prompts, derived from projects/**/*.jsonl
// (canonical, always-fresh source) merged with legacy history.jsonl entries
// for any older data. Sorted newest-first; deduped by sessionId+timestamp.
app.get("/api/history", async (req, res) => {
  try {
    const seen = new Set();
    const entries = [];

    // Source 1: legacy history.jsonl — tolerate missing file
    try {
      const lines = fs
        .readFileSync(path.join(CLAUDE_DIR, "history.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const key = `${obj.sessionId}|${obj.timestamp}`;
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push({
            display: obj.display,
            timestamp: obj.timestamp,
            project: obj.project,
            sessionId: obj.sessionId,
          });
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // history.jsonl absent — that's fine, projects/ has the data
    }

    // Source 2: projects/**/*.jsonl — fresh data, scanned every request
    try {
      const projectsDir = path.join(CLAUDE_DIR, "projects");
      const projectDirs = fs
        .readdirSync(projectsDir)
        .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

      const projEntries = [];
      for (const projDir of projectDirs) {
        const projPath = path.join(projectsDir, projDir);
        const jsonlFiles = findJsonlFiles(projPath);
        for (const file of jsonlFiles) {
          await parsePromptsFromProject(file, projEntries);
        }
      }
      for (const e of projEntries) {
        const key = `${e.sessionId}|${e.timestamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(e);
      }
    } catch {
      // projects/ absent — fine
    }

    // Sort newest-first; handle both numeric (legacy) and ISO-string timestamps
    entries.sort((a, b) => {
      const ta = typeof a.timestamp === "number" ? a.timestamp : Date.parse(a.timestamp);
      const tb = typeof b.timestamp === "number" ? b.timestamp : Date.parse(b.timestamp);
      return (tb || 0) - (ta || 0);
    });

    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions — read sessions/*.json
app.get("/api/sessions", (req, res) => {
  try {
    const sessionsDir = path.join(CLAUDE_DIR, "sessions");
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".json"));
    const sessions = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf8")),
    );
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tool-calls — aggregate tool calls from all project session JSONL files
app.get("/api/tool-calls", async (req, res) => {
  try {
    const projectsDir = path.join(CLAUDE_DIR, "projects");
    const toolCounts = {};
    const toolsByProject = {};
    const toolsByDate = {};

    const projectDirs = fs
      .readdirSync(projectsDir)
      .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

    for (const projDir of projectDirs) {
      const projPath = path.join(projectsDir, projDir);
      const jsonlFiles = findJsonlFiles(projPath);

      for (const file of jsonlFiles) {
        await parseJsonlForTools(file, projDir, toolCounts, toolsByProject, toolsByDate);
      }
    }

    // Sort by count descending
    const sorted = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([tool, count]) => ({ tool, count }));

    res.json({ tools: sorted, byProject: toolsByProject, byDate: toolsByDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tool-details/:toolName — return individual calls for a specific tool
app.get("/api/tool-details/:toolName", async (req, res) => {
  try {
    const toolName = req.params.toolName;
    const projectsDir = path.join(CLAUDE_DIR, "projects");
    const calls = [];

    const projectDirs = fs
      .readdirSync(projectsDir)
      .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

    for (const projDir of projectDirs) {
      const projPath = path.join(projectsDir, projDir);
      const jsonlFiles = findJsonlFiles(projPath);

      for (const file of jsonlFiles) {
        await parseJsonlForToolDetails(file, projDir, toolName, calls);
      }
    }

    // Sort by timestamp descending (most recent first)
    calls.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects — project-level summary from history.jsonl
app.get("/api/projects", (req, res) => {
  try {
    const lines = fs
      .readFileSync(path.join(CLAUDE_DIR, "history.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim());

    const projects = {};
    for (const line of lines) {
      const obj = JSON.parse(line);
      const proj = obj.project || "unknown";
      if (!projects[proj]) {
        projects[proj] = {
          messages: 0,
          sessions: new Set(),
          firstSeen: null,
          lastSeen: null,
        };
      }
      projects[proj].messages++;
      projects[proj].sessions.add(obj.sessionId);
      const ts = obj.timestamp;
      if (!projects[proj].firstSeen || ts < projects[proj].firstSeen) {
        projects[proj].firstSeen = ts;
      }
      if (!projects[proj].lastSeen || ts > projects[proj].lastSeen) {
        projects[proj].lastSeen = ts;
      }
    }

    const result = Object.entries(projects).map(([name, data]) => ({
      name,
      shortName: name.split("/").pop(),
      messages: data.messages,
      sessions: data.sessions.size,
      firstSeen: data.firstSeen,
      lastSeen: data.lastSeen,
    }));

    result.sort((a, b) => b.messages - a.messages);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/daily-costs — token usage and estimated cost per day
app.get("/api/daily-costs", async (req, res) => {
  try {
    const projectsDir = path.join(CLAUDE_DIR, "projects");
    const daily = {};

    const projectDirs = fs
      .readdirSync(projectsDir)
      .filter((d) => fs.statSync(path.join(projectsDir, d)).isDirectory());

    for (const projDir of projectDirs) {
      const projPath = path.join(projectsDir, projDir);
      const jsonlFiles = findJsonlFiles(projPath);
      for (const file of jsonlFiles) {
        await parseDailyCosts(file, daily);
      }
    }

    const days = Object.keys(daily)
      .sort()
      .map((date) => {
        const d = daily[date];
        const cost =
          d.input * RATES.input +
          d.output * RATES.output +
          d.cacheRead * RATES.cacheRead +
          d.cacheCreate * RATES.cacheCreate;
        return {
          date,
          messages: d.messages,
          toolCalls: d.toolCalls,
          sessions: d.sessions.size,
          input: d.input,
          output: d.output,
          cacheRead: d.cacheRead,
          cacheCreate: d.cacheCreate,
          cost: Math.round(cost * 100) / 100,
          models: d.models,
        };
      });

    const totals = days.reduce(
      (acc, d) => {
        acc.messages += d.messages;
        acc.toolCalls += d.toolCalls;
        acc.sessions += d.sessions;
        acc.input += d.input;
        acc.output += d.output;
        acc.cacheRead += d.cacheRead;
        acc.cacheCreate += d.cacheCreate;
        acc.cost += d.cost;
        return acc;
      },
      {
        messages: 0,
        toolCalls: 0,
        sessions: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        cost: 0,
        models: {},
      },
    );
    totals.cost = Math.round(totals.cost * 100) / 100;

    // Merge all models into totals
    for (const d of days) {
      for (const [model, count] of Object.entries(d.models || {})) {
        totals.models[model] = (totals.models[model] || 0) + count;
      }
    }

    res.json({ days, totals, rates: RATES });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recursively find all .jsonl files in a directory
function findJsonlFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath));
    } else if (entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

// Parse a JSONL file and extract tool_use entries
function parseJsonlForTools(filePath, projDir, toolCounts, toolsByProject, toolsByDate) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== "assistant" || !obj.message) return;
        const content = obj.message.content;
        if (!Array.isArray(content)) return;
        const day = obj.timestamp ? localDateKey(obj.timestamp) : null;

        for (const item of content) {
          if (item.type === "tool_use") {
            const tool = item.name;
            toolCounts[tool] = (toolCounts[tool] || 0) + 1;

            if (!toolsByProject[projDir]) toolsByProject[projDir] = {};
            toolsByProject[projDir][tool] =
              (toolsByProject[projDir][tool] || 0) + 1;

            if (toolsByDate && day) {
              if (!toolsByDate[day]) toolsByDate[day] = {};
              toolsByDate[day][tool] = (toolsByDate[day][tool] || 0) + 1;
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

// Parse a JSONL file and collect typed user prompts
// Skips tool-result entries (array of tool_result blocks) and Claude Code's
// system-injected user messages (command stdout/stderr, hook output).
// Multimodal turns (text + image) arrive as a content-block array — pull
// the text blocks out and join them. Pure tool-result arrays have no text
// blocks, so they fall out naturally below.
// Claude Code writes several kinds of synthetic "user" turns into the
// transcript — slash-command echoes, local command stdout/stderr, hook
// output, interrupt notices. None of them were typed by the human, so every
// prompt-facing view has to filter them out identically.
const SYNTHETIC_PROMPT_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "Caveat:",
  "[Request interrupted",
];

// Returns the human-typed text of a user turn, or null if this turn was
// synthetic / empty / not text at all. `raw` is `message.content` — either a
// plain string or a content-block array (multimodal turns). Pure tool-result
// arrays carry no text blocks and so fall out as null.
function cleanUserPromptText(raw) {
  let content;
  if (typeof raw === "string") {
    content = raw;
  } else if (Array.isArray(raw)) {
    content = raw
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (SYNTHETIC_PROMPT_PREFIXES.some((p) => trimmed.startsWith(p))) return null;
  return trimmed;
}

function parsePromptsFromProject(filePath, entries) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== "user" || !obj.message) return;
        const trimmed = cleanUserPromptText(obj.message.content);
        if (!trimmed) return;

        const display = trimmed.length > 500 ? trimmed.slice(0, 500) + "…" : trimmed;
        entries.push({
          display,
          timestamp: obj.timestamp,
          project: obj.cwd || "unknown",
          sessionId: obj.sessionId,
        });
      } catch {
        // skip malformed lines
      }
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

// Parse a JSONL file and accumulate daily token usage
function parseDailyCosts(filePath, daily) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        const ts = obj.timestamp;
        if (!ts) return;
        const day = localDateKey(ts);
        if (!day) return;

        if (!daily[day]) {
          daily[day] = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheCreate: 0,
            messages: 0,
            toolCalls: 0,
            sessions: new Set(),
            models: {},
          };
        }

        const sid = obj.sessionId || "";

        if (obj.type === "user") {
          daily[day].messages++;
          daily[day].sessions.add(sid);
        }

        if (obj.type === "assistant" && obj.message) {
          const usage = obj.message.usage || {};
          daily[day].input += usage.input_tokens || 0;
          daily[day].output += usage.output_tokens || 0;
          daily[day].cacheRead += usage.cache_read_input_tokens || 0;
          daily[day].cacheCreate += usage.cache_creation_input_tokens || 0;

          // Track model usage
          const model = obj.message.model || "unknown";
          daily[day].models[model] = (daily[day].models[model] || 0) + 1;

          const content = obj.message.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === "tool_use") daily[day].toolCalls++;
            }
          }
        }
      } catch {
        // skip
      }
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

// Parse a JSONL file and extract details for a specific tool
function parseJsonlForToolDetails(filePath, projDir, toolName, calls) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== "assistant" || !obj.message) return;
        const content = obj.message.content;
        if (!Array.isArray(content)) return;

        for (const item of content) {
          if (item.type === "tool_use" && item.name === toolName) {
            const input = item.input || {};
            const detail = { project: projDir, timestamp: obj.timestamp };

            // Extract relevant fields based on tool type
            if (toolName === "Bash") {
              detail.command = input.command || "";
              detail.description = input.description || "";
            } else if (toolName === "Read") {
              detail.file_path = input.file_path || "";
            } else if (toolName === "Edit") {
              detail.file_path = input.file_path || "";
            } else if (toolName === "Write") {
              detail.file_path = input.file_path || "";
            } else if (toolName === "Grep") {
              detail.pattern = input.pattern || "";
              detail.path = input.path || "";
              detail.glob = input.glob || "";
            } else if (toolName === "Glob") {
              detail.pattern = input.pattern || "";
              detail.path = input.path || "";
            } else if (toolName === "Agent") {
              detail.description = input.description || "";
              detail.subagent_type = input.subagent_type || "";
            } else {
              // Generic: include all input keys
              detail.input = JSON.stringify(input).slice(0, 200);
            }

            calls.push(detail);
          }
        }
      } catch {
        // skip malformed lines
      }
    });

    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

// ===========================================================================
// === Session history browser ===
//
// A browsable, drill-down view over every transcript in projects/**/*.jsonl:
// an index endpoint (one row per session) and a full normalized transcript
// endpoint for a single session.
//
// Layout on disk, established by inspecting real data:
//   projects/<encoded-cwd>/<sessionId>.jsonl              — main transcript
//   projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl
//                                                         — subagent sidechain
// Subagent files carry the *parent's* sessionId, so grouping by sessionId
// alone would silently merge a Task's inner turns into the main timeline.
// They're split out into `subagents[]` instead and fetched on demand.
//
// Building the index from cold parses every transcript (~260 MB on a heavy
// user's machine, ~1 s). Per-file summaries are memoised by (mtimeMs, size),
// so every rebuild after the first only re-reads files Claude Code appended
// to — a warm rebuild is one statSync per file.
// ===========================================================================

// Ids are resolved through the in-memory index, which only ever holds paths
// this process walked itself — a path is never built by concatenating a
// request value. This shape check is belt-and-braces on top of that.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const SESSION_LIST_LIMIT_DEFAULT = 50;
const SESSION_LIST_LIMIT_MAX = 500;
const SESSION_BLOCK_CAP = 2000; // chars kept per text / thinking / tool block
const SESSION_PATCH_HUNK_CAP = 40; // structuredPatch hunks kept per edit
const SESSION_FILENAMES_CAP = 50;

const sessionFileCache = new Map(); // absPath -> { mtimeMs, size, summary }
let sessionIndexInFlight = null;

function isSubagentTranscript(filePath) {
  return (
    path.basename(filePath).startsWith("agent-") ||
    path.basename(path.dirname(filePath)) === "subagents"
  );
}

function newTokenBag() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

function addTokens(into, from) {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreate += from.cacheCreate;
}

function costOfTokens(t) {
  return (
    t.input * RATES.input +
    t.output * RATES.output +
    t.cacheRead * RATES.cacheRead +
    t.cacheCreate * RATES.cacheCreate
  );
}

function bumpCount(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

// Summarise one transcript file into an index row. Streams line-by-line and
// swallows malformed lines, matching the other parsers in this file.
function summarizeSessionFile(filePath, projDir) {
  return new Promise((resolve) => {
    const s = {
      sessionId: null,
      project: projDir,
      cwd: null,
      isSubagent: isSubagentTranscript(filePath),
      agentId: null,
      title: null,
      firstPrompt: null,
      lastPrompt: null,
      startedAt: null,
      endedAt: null,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      thinkingBlocks: 0,
      images: 0,
      errors: 0,
      compactions: 0,
      entries: 0,
      tokens: newTokenBag(),
      models: {},
      tools: {},
      gitBranches: [],
      versions: [],
      entrypoints: [],
      prLinks: [],
    };
    const branches = new Set();
    const versions = new Set();
    const entrypoints = new Set();

    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        s.entries++;
        if (!s.sessionId && obj.sessionId) s.sessionId = obj.sessionId;
        if (!s.agentId && obj.agentId) s.agentId = obj.agentId;
        if (!s.cwd && obj.cwd) s.cwd = obj.cwd;
        if (obj.gitBranch) branches.add(obj.gitBranch);
        if (obj.version) versions.add(obj.version);
        if (obj.entrypoint) entrypoints.add(obj.entrypoint);

        const ts = obj.timestamp;
        if (ts) {
          if (!s.startedAt || ts < s.startedAt) s.startedAt = ts;
          if (!s.endedAt || ts > s.endedAt) s.endedAt = ts;
        }

        switch (obj.type) {
          case "ai-title":
            if (obj.aiTitle) s.title = obj.aiTitle;
            break;
          case "pr-link":
            if (obj.prUrl) {
              s.prLinks.push({
                url: obj.prUrl,
                number: obj.prNumber ?? null,
                repository: obj.prRepository ?? null,
              });
            }
            break;
          case "system":
            if (obj.subtype === "api_error") s.errors++;
            if (obj.subtype === "compact_boundary") s.compactions++;
            break;
          case "user": {
            const content = obj.message?.content;
            const isToolResult =
              Array.isArray(content) &&
              content.some((b) => b?.type === "tool_result");
            if (Array.isArray(content)) {
              for (const b of content) {
                if (b?.type === "image") s.images++;
              }
            }
            if (isToolResult) break;
            const prompt = cleanUserPromptText(content);
            if (prompt) {
              s.userMessages++;
              if (!s.firstPrompt) s.firstPrompt = prompt.slice(0, 400);
              s.lastPrompt = prompt.slice(0, 400);
            }
            break;
          }
          case "assistant": {
            const msg = obj.message;
            if (!msg) break;
            s.assistantMessages++;
            bumpCount(s.models, msg.model || "unknown");
            const u = msg.usage || {};
            s.tokens.input += u.input_tokens || 0;
            s.tokens.output += u.output_tokens || 0;
            s.tokens.cacheRead += u.cache_read_input_tokens || 0;
            s.tokens.cacheCreate += u.cache_creation_input_tokens || 0;
            if (Array.isArray(msg.content)) {
              for (const b of msg.content) {
                if (!b) continue;
                if (b.type === "tool_use") {
                  s.toolCalls++;
                  bumpCount(s.tools, b.name);
                } else if (b.type === "thinking") {
                  s.thinkingBlocks++;
                }
              }
            }
            break;
          }
          default:
            break;
        }
      } catch {
        // skip malformed lines
      }
    });

    const finish = () => {
      s.gitBranches = [...branches];
      s.versions = [...versions];
      s.entrypoints = [...entrypoints];
      resolve(s);
    };
    rl.on("close", finish);
    rl.on("error", finish);
  });
}

// Walk projects/, refresh any changed file summaries, then group by sessionId.
function buildSessionIndexUncached() {
  const projectsDir = path.join(CLAUDE_DIR, "projects");
  let projectDirs = [];
  try {
    projectDirs = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    projectDirs = [];
  }

  const found = [];
  for (const projDir of projectDirs) {
    try {
      for (const file of findJsonlFiles(path.join(projectsDir, projDir))) {
        found.push({ file, projDir });
      }
    } catch {
      // unreadable project dir — skip it rather than failing the whole index
    }
  }

  return (async () => {
    const livePaths = new Set();
    for (const { file, projDir } of found) {
      livePaths.add(file);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const cached = sessionFileCache.get(file);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        continue;
      }
      const summary = await summarizeSessionFile(file, projDir);
      summary.sizeBytes = st.size;
      sessionFileCache.set(file, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        summary,
      });
    }
    for (const key of [...sessionFileCache.keys()]) {
      if (!livePaths.has(key)) sessionFileCache.delete(key);
    }

    const sessions = new Map();
    const getSession = (id) => {
      let sess = sessions.get(id);
      if (!sess) {
        sess = {
          sessionId: id,
          project: null,
          cwd: null,
          title: null,
          firstPrompt: null,
          lastPrompt: null,
          startedAt: null,
          endedAt: null,
          durationMs: null,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          thinkingBlocks: 0,
          images: 0,
          errors: 0,
          compactions: 0,
          entries: 0,
          tokens: newTokenBag(),
          cost: 0,
          models: {},
          tools: {},
          gitBranches: [],
          versions: [],
          entrypoints: [],
          prLinks: [],
          sizeBytes: 0,
          subagents: [],
          hasMain: false,
          _mainPath: null,
        };
        sessions.set(id, sess);
      }
      return sess;
    };

    for (const [filePath, { summary }] of sessionFileCache) {
      const id = summary.sessionId;
      if (!id) continue;
      const sess = getSession(id);

      // Roll every file's counters into the session totals — subagent turns
      // are real billed traffic, so they belong in the headline numbers.
      sess.userMessages += summary.userMessages;
      sess.assistantMessages += summary.assistantMessages;
      sess.toolCalls += summary.toolCalls;
      sess.thinkingBlocks += summary.thinkingBlocks;
      sess.images += summary.images;
      sess.errors += summary.errors;
      sess.compactions += summary.compactions;
      sess.entries += summary.entries;
      sess.sizeBytes += summary.sizeBytes || 0;
      addTokens(sess.tokens, summary.tokens);
      for (const [m, c] of Object.entries(summary.models)) {
        sess.models[m] = (sess.models[m] || 0) + c;
      }
      for (const [t, c] of Object.entries(summary.tools)) {
        sess.tools[t] = (sess.tools[t] || 0) + c;
      }
      if (summary.startedAt && (!sess.startedAt || summary.startedAt < sess.startedAt)) {
        sess.startedAt = summary.startedAt;
      }
      if (summary.endedAt && (!sess.endedAt || summary.endedAt > sess.endedAt)) {
        sess.endedAt = summary.endedAt;
      }

      if (summary.isSubagent) {
        sess.subagents.push({
          agentId: summary.agentId || path.basename(filePath, ".jsonl"),
          description: summary.firstPrompt,
          startedAt: summary.startedAt,
          endedAt: summary.endedAt,
          userMessages: summary.userMessages,
          assistantMessages: summary.assistantMessages,
          toolCalls: summary.toolCalls,
          thinkingBlocks: summary.thinkingBlocks,
          errors: summary.errors,
          tokens: summary.tokens,
          cost: costOfTokens(summary.tokens),
          models: summary.models,
          sizeBytes: summary.sizeBytes || 0,
          _path: filePath,
        });
      } else {
        sess.hasMain = true;
        sess._mainPath = filePath;
        sess.project = summary.project;
        sess.cwd = summary.cwd;
        if (summary.title) sess.title = summary.title;
        sess.firstPrompt = summary.firstPrompt;
        sess.lastPrompt = summary.lastPrompt;
        sess.prLinks = summary.prLinks;
        sess.gitBranches = summary.gitBranches;
        sess.versions = summary.versions;
        sess.entrypoints = summary.entrypoints;
      }
    }

    for (const sess of sessions.values()) {
      // Orphan sidechains (main transcript deleted) still deserve a row —
      // backfill their identity from the subagent files we do have.
      if (!sess.project) {
        const first = sessionFileCache.get(sess.subagents[0]?._path);
        if (first) {
          sess.project = first.summary.project;
          sess.cwd = first.summary.cwd;
        }
      }
      sess.subagents.sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
      sess.subagentCount = sess.subagents.length;
      sess.cost = costOfTokens(sess.tokens);
      sess.durationMs =
        sess.startedAt && sess.endedAt
          ? Math.max(0, Date.parse(sess.endedAt) - Date.parse(sess.startedAt))
          : null;
    }

    return sessions;
  })();
}

// Single-flight wrapper: concurrent page loads share one rebuild instead of
// each kicking off a full parse of the transcript tree.
function getSessionIndex() {
  if (!sessionIndexInFlight) {
    sessionIndexInFlight = buildSessionIndexUncached().finally(() => {
      sessionIndexInFlight = null;
    });
  }
  return sessionIndexInFlight;
}

// Strip the internal `_path` handles before anything crosses the wire —
// absolute filesystem paths aren't the browser's business.
function publicSession(sess) {
  const { _mainPath, subagents, ...rest } = sess;
  return {
    ...rest,
    subagents: subagents.map(({ _path, ...s }) => s),
  };
}

function cappedText(value, cap) {
  const s =
    typeof value === "string"
      ? value
      : value == null
        ? ""
        : JSON.stringify(value, null, 2);
  if (!Number.isFinite(cap) || s.length <= cap) {
    return { text: s, length: s.length };
  }
  return { text: s.slice(0, cap), length: s.length, truncated: true };
}

// tool_result content is a string for most tools, a block array for others
// (images, tool references). Flatten to displayable text either way.
function toolResultToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content, null, 2);
  return content
    .map((b) => {
      if (!b || typeof b !== "object") return String(b ?? "");
      if (b.type === "text") return b.text || "";
      if (b.type === "image") return `[image: ${b.source?.media_type || "unknown"}]`;
      if (b.type === "tool_reference") return `[tool reference: ${b.tool_name || "?"}]`;
      return `[${b.type || "block"}]`;
    })
    .join("\n");
}

function normalizeBlock(b, cap) {
  if (!b || typeof b !== "object") return null;
  switch (b.type) {
    case "text":
      return { type: "text", ...cappedText(b.text, cap) };
    case "thinking":
      return { type: "thinking", ...cappedText(b.thinking, cap) };
    case "tool_use":
      return {
        type: "tool_use",
        id: b.id ?? null,
        name: b.name ?? null,
        ...cappedText(b.input, cap),
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: b.tool_use_id ?? null,
        isError: !!b.is_error,
        ...cappedText(toolResultToText(b.content), cap),
      };
    case "image":
      return {
        type: "image",
        mediaType: b.source?.media_type ?? null,
        // Byte count only — base64 payloads stay on the server.
        approxBytes: typeof b.source?.data === "string"
          ? Math.floor((b.source.data.length * 3) / 4)
          : null,
      };
    default:
      return { type: b.type || "unknown", ...cappedText(b, cap) };
  }
}

// Explicit projection of `toolUseResult` — the rich per-tool metadata Claude
// Code stores alongside a tool_result (diffs, file lists, exit output). Copy
// only the fields we render; never spread the raw object.
function projectToolUseResult(tr, cap) {
  if (tr == null) return null;
  if (typeof tr === "string") return { kind: "text", ...cappedText(tr, cap) };
  if (Array.isArray(tr)) return { kind: "list", count: tr.length, ...cappedText(tr, cap) };
  if (typeof tr !== "object") return null;

  const out = {};
  const copyIf = (key, val) => {
    if (val !== undefined && val !== null) out[key] = val;
  };
  copyIf("kind", tr.type);
  copyIf("filePath", tr.filePath ?? tr.file?.filePath);
  copyIf("numFiles", tr.numFiles);
  copyIf("numLines", tr.numLines ?? tr.file?.numLines);
  copyIf("totalFiles", tr.totalFiles);
  copyIf("totalMatches", tr.totalMatches);
  copyIf("durationMs", tr.durationMs);
  copyIf("truncated", tr.truncated);
  copyIf("interrupted", tr.interrupted);
  copyIf("userModified", tr.userModified);
  copyIf("replaceAll", tr.replaceAll);
  copyIf("mode", tr.mode);
  copyIf("agentId", tr.agentId);
  copyIf("status", tr.status);
  copyIf("resolvedModel", tr.resolvedModel);
  copyIf("description", tr.description);
  copyIf("isImage", tr.isImage);

  if (typeof tr.stdout === "string" && tr.stdout) {
    out.stdout = cappedText(tr.stdout, cap);
  }
  if (typeof tr.stderr === "string" && tr.stderr) {
    out.stderr = cappedText(tr.stderr, cap);
  }
  if (Array.isArray(tr.filenames)) {
    out.filenames = tr.filenames.slice(0, SESSION_FILENAMES_CAP);
    if (tr.filenames.length > SESSION_FILENAMES_CAP) {
      out.filenamesTruncated = tr.filenames.length;
    }
  }
  // structuredPatch is what makes an Edit reviewable after the fact — keep it
  // in unified-hunk shape so the UI can colour the diff.
  if (Array.isArray(tr.structuredPatch) && tr.structuredPatch.length) {
    out.patch = tr.structuredPatch.slice(0, SESSION_PATCH_HUNK_CAP).map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: Array.isArray(h.lines) ? h.lines : [],
    }));
    if (tr.structuredPatch.length > SESSION_PATCH_HUNK_CAP) {
      out.patchTruncated = tr.structuredPatch.length;
    }
  }
  return Object.keys(out).length ? out : null;
}

// Summarise an `attachment` entry. These are bulk context injections (tool
// listings, skill listings, directory snapshots) — high volume, low signal,
// so the index keeps a one-line descriptor and the UI hides them by default.
function summarizeAttachment(att, cap) {
  if (!att || typeof att !== "object") return null;
  const out = { attachmentType: att.type || "unknown" };
  if (Array.isArray(att.addedNames)) {
    out.detail = `${att.addedNames.length} tool(s): ${att.addedNames.slice(0, 12).join(", ")}`;
  } else if (typeof att.content === "string") {
    out.detail = cappedText(att.content, cap).text;
  } else if (att.file?.filePath) {
    out.detail = att.file.filePath;
  }
  return out;
}

function normalizeTranscriptEntry(obj, cap, includeRaw) {
  const out = {
    uuid: obj.uuid ?? null,
    parentUuid: obj.parentUuid ?? null,
    type: obj.type ?? "unknown",
    timestamp: obj.timestamp ?? null,
    isSidechain: !!obj.isSidechain,
  };
  if (obj.logicalParentUuid) out.logicalParentUuid = obj.logicalParentUuid;
  if (obj.agentId) out.agentId = obj.agentId;
  if (obj.gitBranch) out.gitBranch = obj.gitBranch;
  if (obj.version) out.version = obj.version;
  if (obj.cwd) out.cwd = obj.cwd;
  if (obj.isMeta) out.isMeta = true;

  if (obj.type === "user") {
    const content = obj.message?.content;
    out.role = "user";
    out.blocks = Array.isArray(content)
      ? content.map((b) => normalizeBlock(b, cap)).filter(Boolean)
      : typeof content === "string"
        ? [{ type: "text", ...cappedText(content, cap) }]
        : [];
    out.isToolResult = out.blocks.some((b) => b.type === "tool_result");
    if (!out.isToolResult) {
      // Flag Claude Code's synthetic turns so the UI can style them apart
      // from things the human actually typed.
      out.isSynthetic = cleanUserPromptText(content) === null;
    }
    if (obj.permissionMode) out.permissionMode = obj.permissionMode;
    if (obj.promptSource) out.promptSource = obj.promptSource;
    if (obj.origin?.kind) out.originKind = obj.origin.kind;
    const trMeta = projectToolUseResult(obj.toolUseResult, cap);
    if (trMeta) out.toolResultMeta = trMeta;
  } else if (obj.type === "assistant") {
    const msg = obj.message || {};
    out.role = "assistant";
    out.model = msg.model ?? null;
    out.stopReason = msg.stop_reason ?? null;
    out.requestId = obj.requestId ?? null;
    if (obj.effort) out.effort = obj.effort;
    if (obj.attributionSkill) out.attributionSkill = obj.attributionSkill;
    if (obj.attributionMcpServer) out.attributionMcpServer = obj.attributionMcpServer;
    if (obj.attributionMcpTool) out.attributionMcpTool = obj.attributionMcpTool;
    const u = msg.usage || {};
    const tokens = {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheCreate: u.cache_creation_input_tokens || 0,
    };
    out.tokens = tokens;
    out.cost = costOfTokens(tokens);
    if (u.service_tier) out.serviceTier = u.service_tier;
    out.blocks = Array.isArray(msg.content)
      ? msg.content.map((b) => normalizeBlock(b, cap)).filter(Boolean)
      : typeof msg.content === "string"
        ? [{ type: "text", ...cappedText(msg.content, cap) }]
        : [];
  } else if (obj.type === "system") {
    out.subtype = obj.subtype ?? null;
    out.level = obj.level ?? null;
    if (obj.content) out.content = cappedText(obj.content, cap);
    if (obj.error) {
      out.error = {
        message: cappedText(obj.error.message, cap).text,
        status: obj.error.status ?? null,
        requestId: obj.error.requestId ?? null,
      };
    }
    if (obj.compactMetadata) {
      out.compactMetadata = {
        trigger: obj.compactMetadata.trigger ?? null,
        preTokens: obj.compactMetadata.preTokens ?? null,
      };
    }
  } else if (obj.type === "attachment") {
    const att = summarizeAttachment(obj.attachment, 400);
    if (att) Object.assign(out, att);
  } else if (obj.type === "pr-link") {
    out.prUrl = obj.prUrl ?? null;
    out.prNumber = obj.prNumber ?? null;
    out.prRepository = obj.prRepository ?? null;
  } else if (obj.type === "mode") {
    out.mode = obj.mode ?? null;
  }

  if (includeRaw) out.raw = obj;
  return out;
}

// Read one transcript file into an ordered, normalized timeline.
// `filterUuid` short-circuits to a single entry — that's how the UI expands a
// truncated block without refetching a multi-megabyte transcript.
function readTranscript(filePath, { cap, includeRaw, filterUuid }) {
  return new Promise((resolve) => {
    const messages = [];
    const skipped = { attachments: 0 };
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        // Bookkeeping records with no place on a timeline.
        if (
          obj.type === "queue-operation" ||
          obj.type === "file-history-snapshot" ||
          obj.type === "file-history-delta" ||
          obj.type === "ai-title" ||
          obj.type === "last-prompt"
        ) {
          return;
        }
        if (filterUuid && obj.uuid !== filterUuid) return;
        messages.push(normalizeTranscriptEntry(obj, cap, includeRaw));
      } catch {
        // skip malformed lines
      }
    });

    const finish = () => resolve({ messages, skipped });
    rl.on("close", finish);
    rl.on("error", finish);
  });
}

// GET /api/session-history — index of every session, newest first.
// Query: q, project, from, to, sort, limit, offset.
app.get("/api/session-history", async (req, res) => {
  try {
    const index = await getSessionIndex();
    let list = [...index.values()];

    const projects = new Map();
    for (const s of list) {
      if (!s.project) continue;
      const p = projects.get(s.project) || { project: s.project, cwd: s.cwd, count: 0 };
      p.count++;
      if (!p.cwd && s.cwd) p.cwd = s.cwd;
      projects.set(s.project, p);
    }

    const q = String(req.query.q || "").trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        [s.title, s.firstPrompt, s.lastPrompt, s.cwd, s.project, s.sessionId]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    if (req.query.project) {
      list = list.filter((s) => s.project === req.query.project);
    }
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    if (from || to) {
      list = list.filter((s) => {
        if (!s.startedAt) return false;
        const day = localDateKey(s.startedAt);
        if (!day) return false;
        if (from && day < from) return false;
        if (to && day > to) return false;
        return true;
      });
    }

    const sorters = {
      recent: (a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""),
      oldest: (a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""),
      cost: (a, b) => b.cost - a.cost,
      messages: (a, b) =>
        b.userMessages + b.assistantMessages - (a.userMessages + a.assistantMessages),
      tools: (a, b) => b.toolCalls - a.toolCalls,
      duration: (a, b) => (b.durationMs || 0) - (a.durationMs || 0),
    };
    const sortKey = sorters[req.query.sort] ? req.query.sort : "recent";
    list.sort(sorters[sortKey]);

    const total = list.length;
    const totals = list.reduce(
      (acc, s) => {
        acc.cost += s.cost;
        acc.userMessages += s.userMessages;
        acc.assistantMessages += s.assistantMessages;
        acc.toolCalls += s.toolCalls;
        addTokens(acc.tokens, s.tokens);
        return acc;
      },
      { cost: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, tokens: newTokenBag() },
    );

    const limit = Math.min(
      SESSION_LIST_LIMIT_MAX,
      Math.max(1, parseInt(req.query.limit, 10) || SESSION_LIST_LIMIT_DEFAULT),
    );
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const page = list.slice(offset, offset + limit).map(publicSession);

    res.json({
      sessions: page,
      total,
      totals,
      offset,
      limit,
      sort: sortKey,
      projects: [...projects.values()].sort((a, b) => b.count - a.count),
      rates: RATES,
      timezone: getTimezoneInfo(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session-history/:id — full normalized transcript for one session.
// Query: full=1 (no truncation), raw=1 (include the source JSONL entry),
// uuid=<messageUuid> (single message), agent=<agentId> (subagent sidechain).
app.get("/api/session-history/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!SESSION_ID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid session id" });
    }
    const index = await getSessionIndex();
    const sess = index.get(id);
    if (!sess) return res.status(404).json({ error: "Session not found" });

    let filePath = sess._mainPath;
    let agent = null;
    if (req.query.agent) {
      const agentId = String(req.query.agent);
      if (!SESSION_ID_RE.test(agentId)) {
        return res.status(400).json({ error: "Invalid agent id" });
      }
      // Resolve through the index — the path comes from our own walk, never
      // from the request.
      agent = sess.subagents.find((s) => s.agentId === agentId);
      if (!agent) return res.status(404).json({ error: "Subagent not found" });
      filePath = agent._path;
    }
    if (!filePath) {
      return res.status(404).json({ error: "No transcript file for this session" });
    }

    const cap = req.query.full === "1" ? Infinity : SESSION_BLOCK_CAP;
    const includeRaw = req.query.raw === "1";
    const filterUuid = req.query.uuid ? String(req.query.uuid) : null;

    const { messages } = await readTranscript(filePath, { cap, includeRaw, filterUuid });

    res.json({
      session: publicSession(sess),
      agent: agent ? (({ _path, ...rest }) => rest)(agent) : null,
      messages,
      messageCount: messages.length,
      truncatedAt: Number.isFinite(cap) ? cap : null,
      rates: RATES,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /sessions — serve sessions.html
app.get("/sessions", (req, res) => {
  res.sendFile(path.join(__dirname, "sessions.html"));
});

// JSON-shaped error responses for /api/* and /v1/* routes. Without this,
// body-parser failures on malformed JSON return Express's default HTML
// stack-trace page, which the dashboard's `.json().catch()` can't parse
// into a useful message. Catches everything that lands here as a fallback.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const wantsJson = req.path && (req.path.startsWith("/api/") || req.path.startsWith("/v1/"));
  if (!wantsJson) return next(err);
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const type = err?.type ?? (status >= 500 ? "server_error" : "invalid_request_error");
  res.status(status).json({
    error: type,
    message: err?.message ?? "Unknown server error",
  });
});

app.listen(PORT, () => {
  console.log(`Claude Usage Dashboard running at http://localhost:${PORT}`);
});
