export interface CanonicalPrompt {
  stablePrefix: string;
  dynamicSuffix: string;
  auditHash: string;
  cacheHash: string;
}

export interface CanonicalToolSchema {
  toolsJson: string;
  toolsHash: string;
}

export function canonicalizePrompt(input: {
  stablePrefix: unknown;
  dynamicSuffix: unknown;
  provider: string;
  model: string;
  templateVersion: string;
}): CanonicalPrompt {
  const stablePrefix = canonicalJson(input.stablePrefix);
  const dynamicSuffix = canonicalJson(input.dynamicSuffix);
  const cacheHash = stableHash(
    canonicalJson({
      provider: input.provider,
      model: input.model,
      templateVersion: input.templateVersion,
      stablePrefix,
    })
  );
  const auditHash = stableHash(
    canonicalJson({
      provider: input.provider,
      model: input.model,
      templateVersion: input.templateVersion,
      stablePrefix,
      dynamicSuffix,
    })
  );
  return { stablePrefix, dynamicSuffix, auditHash, cacheHash };
}

export function canonicalizeToolSchema(tools: Array<{ name: string; schema: unknown }>): CanonicalToolSchema {
  const normalized = [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => ({ name: tool.name, schema: sortJsonValue(tool.schema, true) }));
  const toolsJson = canonicalJson(normalized);
  return { toolsJson, toolsHash: stableHash(toolsJson) };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value, false));
}

function sortJsonValue(value: unknown, sortArrays: boolean): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => sortJsonValue(item, sortArrays));
    return sortArrays ? [...items].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) : items;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const fieldValue = source[key];
      if (fieldValue !== undefined) {
        result[key] = sortJsonValue(fieldValue, sortArrays);
      }
    }
    return result;
  }
  return value;
}

export function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
