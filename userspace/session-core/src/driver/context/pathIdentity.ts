export class PathIdentity {
  normalizeRelativePath(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const normalized = this.normalizeSlashes(value).replace(/^\.\/+/, '').replace(/^\/+/, '');
    const parts: string[] = [];
    for (const part of normalized.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') return undefined;
      parts.push(part);
    }
    return parts.join('/') || '.';
  }

  normalizeSlashes(value: string): string {
    return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  comparablePath(value: string): string {
    return this.normalizeSlashes(value).replace(/\/+$/g, '');
  }

  isAbsolutePath(value: string): boolean {
    return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
  }

  normalizePlanScope(value: string): string {
    return value
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+/g, '/')
      .trim();
  }

  normalizePlanScopeIdentity(value: string): string {
    return this.normalizePlanScope(value).replace(/\/+$/, '');
  }

  expandPlanTargetTokens(target: string): string[] {
    if (!target || !target.trim()) return [];
    const candidates = target.match(/[A-Za-z0-9_.\-/]+/g) ?? [];
    const pathLike = candidates.filter((token) => token.includes('/') || /\.[A-Za-z0-9]+$/.test(token));
    return pathLike.length ? pathLike : [target.trim()];
  }

  dirnameLike(value: string): string | undefined {
    const normalized = this.normalizePlanScope(value).replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    if (index <= 0) return undefined;
    return normalized.slice(0, index);
  }
}
