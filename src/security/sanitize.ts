export function sanitizeControlChars(input: string, maxLength?: number): string {
  let out = "";
  let i = 0;

  while (i < input.length) {
    const code = input.charCodeAt(i);

    if (code === 0x1b) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : -1;
      if (next === 0x5b) {
        // Skip ANSI CSI sequence: ESC [ ... <0x40..0x7e>
        i += 2;
        while (i < input.length) {
          const b = input.charCodeAt(i);
          i += 1;
          if (b >= 0x40 && b <= 0x7e) {
            break;
          }
        }
        continue;
      }
      if (next === 0x5d) {
        // Skip ANSI OSC sequence: ESC ] ... (BEL | ST)
        i += 2;
        while (i < input.length) {
          const b = input.charCodeAt(i);
          if (b === 0x07) {
            i += 1;
            break;
          }
          if (b === 0x1b && i + 1 < input.length && input.charCodeAt(i + 1) === 0x5c) {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }
      if (next >= 0x40 && next <= 0x5f) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (code === 0x0d || code === 0x0a || code === 0x09) {
      out += " ";
      i += 1;
      continue;
    }

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      i += 1;
      continue;
    }

    out += input[i] ?? "";
    i += 1;
  }

  const trimmed = out.trim();
  if (maxLength !== undefined && trimmed.length > maxLength) {
    return trimmed.slice(0, Math.max(0, maxLength));
  }
  return trimmed;
}

export function escapeDiscordMarkdown(input: string): string {
  const escaped = input
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("`", "\\`")
    .replaceAll("~", "\\~")
    .replaceAll("|", "\\|");
  return escaped.replace(/^>+/, (match) => `\\${match}`);
}

const HIGH_ENTROPY_SEGMENT_RE = /^[A-Za-z0-9._:-]{20,}$/;

function redactPathname(pathname: string): string {
  if (/^\/bot[^/]+(\/.*)?$/i.test(pathname)) {
    return pathname.replace(
      /^\/bot[^/]+(\/.*)?$/i,
      (_m, rest: string | undefined) => `/bot***${rest ?? ""}`,
    );
  }

  if (/^(\/api)?\/webhooks\/[^/]+\/[^/]+(\/.*)?$/i.test(pathname)) {
    return pathname.replace(
      /^(\/api)?\/webhooks\/[^/]+\/[^/]+(\/.*)?$/i,
      (_m, apiPrefix: string | undefined, rest: string | undefined) =>
        `${apiPrefix ?? ""}/webhooks/***/***${rest ?? ""}`,
    );
  }

  if (/^(\/(?:api\/)?v\d+)\/([^/]+)(\/.*)?$/i.test(pathname)) {
    return pathname.replace(
      /^(\/(?:api\/)?v\d+)\/([^/]+)(\/.*)?$/i,
      (_m, verPrefix: string, _key: string, rest: string | undefined) =>
        `${verPrefix}/***${rest ?? ""}`,
    );
  }

  const segments = pathname.split("/");
  let modified = false;
  const masked = segments.map((segment) => {
    if (HIGH_ENTROPY_SEGMENT_RE.test(segment)) {
      modified = true;
      return "***";
    }
    return segment;
  });
  return modified ? masked.join("/") : pathname;
}

export function redactUrlSecrets(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) {
      parsed.username = "***";
    }
    if (parsed.password) {
      parsed.password = "***";
    }
    parsed.pathname = redactPathname(parsed.pathname);

    const uniqueKeys = [...new Set(parsed.searchParams.keys())];
    for (const key of uniqueKeys) {
      parsed.searchParams.set(key, "***");
    }

    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}

export function sanitizeSecretText(input: string, maxLength = 500): string {
  const clean = sanitizeControlChars(input);
  const redactedUrls = clean.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (match) =>
    redactUrlSecrets(match),
  );
  const redactedHeaders = redactedUrls.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    "$1 [REDACTED]",
  );
  const redactedBotTokens = redactedHeaders.replace(
    /\b\d{5,15}:[A-Za-z0-9_-]{16,}\b/g,
    "[REDACTED_BOT_TOKEN]",
  );

  if (redactedBotTokens.length > maxLength) {
    return redactedBotTokens.slice(0, Math.max(0, maxLength));
  }
  return redactedBotTokens;
}
