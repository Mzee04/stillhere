export function parseEnvContent(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = parseEnvValue(match[2]);
  }
  return values;
}

export function parseEnvValue(raw) {
  if (raw.startsWith("\"")) return readQuotedValue(raw, "\"", true);
  if (raw.startsWith("'")) return readQuotedValue(raw, "'", false);
  const commentAt = raw.search(/\s+#/);
  return (commentAt === -1 ? raw : raw.slice(0, commentAt)).trimEnd();
}

function readQuotedValue(raw, quote, allowEscapes) {
  let output = "";
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (allowEscapes && char === "\\" && index + 1 < raw.length) {
      const next = raw[index + 1];
      const escaped = { n: "\n", r: "\r", t: "\t", '"': '"', "'": "'", "\\": "\\" };
      output += escaped[next] ?? next;
      index += 1;
      continue;
    }
    if (char === quote) return output;
    output += char;
  }
  return output;
}
