import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

const OPENCODE_TRANSIENT_UPSTREAM_RE =
  /(?:high\s+demand|temporary\s+errors?|temporar(?:y|ily)\s+unavailable|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|server\s+overloaded|\boverloaded\b|service\s+unavailable|\b50[234]\b|upstream|try\s+again\s+later|capacity)/i;

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}

function buildOpenCodeErrorHaystack(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  return [input.errorMessage ?? "", input.stdout ?? "", input.stderr ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function durationMsFromText(amountText: string, unitText: string | null | undefined): number | null {
  const amount = Number.parseFloat(amountText);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (unitText ?? "seconds").toLowerCase();
  if (/^m(?:s|illi(?:second)?s?)?$/.test(unit)) return amount;
  if (/^(?:s|sec|secs|second|seconds)$/.test(unit)) return amount * 1000;
  if (/^(?:m|min|mins|minute|minutes)$/.test(unit)) return amount * 60 * 1000;
  if (/^(?:h|hr|hrs|hour|hours)$/.test(unit)) return amount * 60 * 60 * 1000;
  return null;
}

export function extractOpenCodeRetryNotBefore(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}, now = new Date()): Date | null {
  const haystack = buildOpenCodeErrorHaystack(input);
  const retryAfterMatch = haystack.match(/retry[-\s]?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*([a-z]+)?/i);
  const tryAgainInMatch = haystack.match(/try\s+again\s+in\s+(\d+(?:\.\d+)?)\s*([a-z]+)?/i);
  const match = retryAfterMatch ?? tryAgainInMatch;
  if (!match) return null;
  const delayMs = durationMsFromText(match[1] ?? "", match[2]);
  if (!delayMs) return null;
  return new Date(now.getTime() + delayMs);
}

export function isOpenCodeTransientUpstreamError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildOpenCodeErrorHaystack(input);
  return OPENCODE_TRANSIENT_UPSTREAM_RE.test(haystack);
}
