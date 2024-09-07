/**
 * Partitioned page-shard storage (`GitPartitionedEngine<Row>`) and HTTP Range reader (`GitSqliteVfs`).
 *
 * - `GitPartitionedEngine`: partitions rows into fixed-size JSON page shards under
 *   `db/<dbName>/pages/page_XXXX.json` indexed by `db/<dbName>/manifest.json`
 *   (primary key map, inverted token index, and per-page vector centroids).
 * - `GitSqliteVfs`: reads fixed-size binary pages via `Range: bytes=start-end`
 *   with an in-memory LRU page cache.
 */
import { GitRepoStore, sanitizeRepoPath } from './store.js';
import { TableRow, cosineSimilarity } from './table.js';

export interface PartitionPageMeta {
  pageIndex: number;
  path: string;
  rowCount: number;
  minId: string;
  maxId: string;
  /** Mean vector of all row embeddings stored in this page shard */
  vectorCentroid?: number[];
}

export interface PartitionManifest {
  dbName: string;
  version: number;
  pageSize: number;
  totalRows: number;
  updatedAt: number;
  pages: PartitionPageMeta[];
  /** Primary key `id` -> `pageIndex` */
  primaryKeyIndex: Record<string, number>;
  /** Token -> sorted `pageIndex[]` posting list */
  invertedTokenIndex: Record<string, number[]>;
}

export interface PartitionEngineOptions {
  /** Maximum rows per page shard (default: 100) */
  pageSize?: number;
  /** Row fields to index into `invertedTokenIndex` */
  textIndexFields?: string[];
  /** Row field holding a `number[]` embedding for centroid computation */
  vectorField?: string;
  /** Optional repository owner override for public read access */
  ownerOverride?: string;
  /** Optional repository name override */
  repoOverride?: string;
}

export function tokenizeForIndex(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, ' ')
        .split(/\s+/)
        .filter((tok) => tok.length >= 2)
    )
  );
}

function computeCentroid(vectors: number[][]): number[] | undefined {
  if (vectors.length === 0) return undefined;
  const dim = vectors[0].length;
  if (dim === 0) return undefined;
  const sum = new Array<number>(dim).fill(0);
  let count = 0;
  for (const vec of vectors) {
    if (vec.length !== dim) continue;
    for (let i = 0; i < dim; i++) {
      sum[i] += vec[i];
    }
    count += 1;
  }
  if (count === 0) return undefined;
  return sum.map((v) => Number((v / count).toFixed(6)));
}

export class GitPartitionedEngine<Row extends TableRow = TableRow> {
  public readonly dbName: string;
  public readonly options: Required<Omit<PartitionEngineOptions, 'vectorField' | 'ownerOverride' | 'repoOverride'>> & {
    vectorField?: string;
    ownerOverride?: string;
    repoOverride?: string;
  };

  private manifestCache: PartitionManifest | null = null;
  private pageCache: Map<number, Row[]> = new Map();

  constructor(
    public readonly store: GitRepoStore,
    dbName: string,
    options: PartitionEngineOptions = {}
  ) {
    this.dbName = sanitizeRepoPath(dbName).replace(/\//g, '_');
    this.options = {
      pageSize: Math.max(1, options.pageSize ?? 100),
      textIndexFields: options.textIndexFields ?? [],
      vectorField: options.vectorField,
      ownerOverride: options.ownerOverride,
      repoOverride: options.repoOverride,
    };
  }

  private get manifestPath(): string {
    return `db/${this.dbName}/manifest.json`;
  }

  private getPagePath(pageIndex: number): string {
    const padded = String(pageIndex).padStart(4, '0');
    return `db/${this.dbName}/pages/page_${padded}.json`;
  }

  public clearCache(): void {
    this.manifestCache = null;
    this.pageCache.clear();
  }

  /**
   * Partition `rows` into fixed-size page shards and write `manifest.json`.
   */
  public async buildFromRows(rows: readonly Row[]): Promise<PartitionManifest> {
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const pageSize = this.options.pageSize;
    const pages: PartitionPageMeta[] = [];
    const primaryKeyIndex: Record<string, number> = {};
    const tokenToPages = new Map<string, Set<number>>();

    this.clearCache();

    for (let offset = 0; offset < sorted.length; offset += pageSize) {
      const pageIndex = Math.floor(offset / pageSize);
      const chunk = sorted.slice(offset, offset + pageSize);
      const pagePath = this.getPagePath(pageIndex);

      const pageVectors: number[][] = [];
      for (const row of chunk) {
        primaryKeyIndex[row.id] = pageIndex;

        for (const field of this.options.textIndexFields) {
          const val = row[field];
          if (typeof val === 'string' && val.trim()) {
            for (const tok of tokenizeForIndex(val)) {
              if (!tokenToPages.has(tok)) {
                tokenToPages.set(tok, new Set());
              }
              tokenToPages.get(tok)!.add(pageIndex);
            }
          }
        }

        if (this.options.vectorField) {
          const vec = row[this.options.vectorField];
          if (Array.isArray(vec) && vec.length > 0) {
            pageVectors.push(vec as number[]);
          }
        }
      }

      await this.store.writeJSON(
        pagePath,
        chunk,
        `Write partition page ${pageIndex} for ${this.dbName}`
      );
      this.pageCache.set(pageIndex, chunk);

      pages.push({
        pageIndex,
        path: pagePath,
        rowCount: chunk.length,
        minId: chunk[0].id,
        maxId: chunk[chunk.length - 1].id,
        vectorCentroid: computeCentroid(pageVectors),
      });
    }

    const invertedTokenIndex: Record<string, number[]> = {};
    for (const [tok, pageSet] of tokenToPages.entries()) {
      invertedTokenIndex[tok] = Array.from(pageSet).sort((a, b) => a - b);
    }

    const manifest: PartitionManifest = {
      dbName: this.dbName,
      version: Date.now(),
      pageSize,
      totalRows: sorted.length,
      updatedAt: Date.now(),
      pages,
      primaryKeyIndex,
      invertedTokenIndex,
    };

    await this.store.writeJSON(
      this.manifestPath,
      manifest,
      `Update partition manifest for ${this.dbName}`
    );
    this.manifestCache = manifest;
    return manifest;
  }

  /**
   * Load `manifest.json` from the repository (cached in memory after first load).
   */
  public async getManifest(forceRefresh = false): Promise<PartitionManifest | null> {
    if (this.manifestCache && !forceRefresh) {
      return this.manifestCache;
    }
    try {
      const manifest = await this.store.readJSON<PartitionManifest>(
        this.manifestPath,
        this.options.ownerOverride,
        this.options.repoOverride
      );
      this.manifestCache = manifest;
      return manifest;
    } catch {
      return null;
    }
  }

  /**
   * Load a single page shard by `pageIndex`.
   */
  public async readPage(pageIndex: number): Promise<Row[]> {
    if (this.pageCache.has(pageIndex)) {
      return this.pageCache.get(pageIndex)!;
    }
    const pagePath = this.getPagePath(pageIndex);
    const rows = await this.store.readJSON<Row[]>(
      pagePath,
      this.options.ownerOverride,
      this.options.repoOverride
    );
    const list = Array.isArray(rows) ? rows : [];
    this.pageCache.set(pageIndex, list);
    return list;
  }

  /**
   * Look up a single row by `id`, reading only the page shard recorded in `primaryKeyIndex`.
   */
  public async getById(id: string): Promise<Row | null> {
    const manifest = await this.getManifest();
    if (!manifest) return null;
    const pageIndex = manifest.primaryKeyIndex[id];
    if (pageIndex === undefined) return null;
    const pageRows = await this.readPage(pageIndex);
    return pageRows.find((r) => r.id === id) ?? null;
  }

  /**
   * Query the inverted token index and load only the matching page shards.
   */
  public async searchText(query: string, limit = 10): Promise<Row[]> {
    const manifest = await this.getManifest();
    if (!manifest) return [];

    const queryTokens = tokenizeForIndex(query);
    if (queryTokens.length === 0) return [];

    const pageHitCounts = new Map<number, number>();
    for (const tok of queryTokens) {
      const matchingPages = manifest.invertedTokenIndex[tok] ?? [];
      for (const pIdx of matchingPages) {
        pageHitCounts.set(pIdx, (pageHitCounts.get(pIdx) ?? 0) + 1);
      }
    }

    const candidatePages = Array.from(pageHitCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([pIdx]) => pIdx);

    const results: Array<{ row: Row; score: number }> = [];
    for (const pIdx of candidatePages) {
      const pageRows = await this.readPage(pIdx);
      for (const row of pageRows) {
        const combinedText = this.options.textIndexFields
          .map((f) => String(row[f] ?? ''))
          .join(' ')
          .toLowerCase();
        let hits = 0;
        for (const tok of queryTokens) {
          if (combinedText.includes(tok)) hits += 1;
        }
        if (hits > 0) {
          results.push({ row, score: hits / queryTokens.length });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.row);
  }

  /**
   * Rank page shards by centroid cosine similarity, load the top `probePages` shards,
   * and return the highest-scoring rows above `threshold`.
   */
  public async searchVectorANN(options: {
    vector: number[];
    threshold?: number;
    topK?: number;
    probePages?: number;
  }): Promise<Array<Row & { _similarity: number }>> {
    const manifest = await this.getManifest();
    if (!manifest || !this.options.vectorField) return [];

    const { vector, threshold = 0.5, topK = 5, probePages = 2 } = options;
    const vectorField = this.options.vectorField;

    const rankedPages = manifest.pages
      .map((p) => ({
        pageIndex: p.pageIndex,
        centroidSim: p.vectorCentroid ? cosineSimilarity(vector, p.vectorCentroid) : 1,
      }))
      .sort((a, b) => b.centroidSim - a.centroidSim)
      .slice(0, Math.max(1, probePages));

    const pageLists = await Promise.all(rankedPages.map((p) => this.readPage(p.pageIndex)));

    const scored: Array<Row & { _similarity: number }> = [];
    for (const rows of pageLists) {
      for (const row of rows) {
        const candidateVec = row[vectorField];
        if (Array.isArray(candidateVec)) {
          const sim = cosineSimilarity(vector, candidateVec as number[]);
          if (sim >= threshold) {
            scored.push({ ...row, _similarity: sim });
          }
        }
      }
    }

    scored.sort((a, b) => b._similarity - a._similarity);
    return scored.slice(0, topK);
  }
}

/**
 * HTTP Range reader (`GitSqliteVfs`) for fetching fixed-size binary pages (default: 4096 bytes)
 * with an in-memory LRU page cache.
 */
export class GitSqliteVfs {
  public readonly pageSize: number;
  public readonly maxCachedPages: number;
  private readonly fetchImpl: typeof fetch;
  private pageCache: Map<number, Uint8Array> = new Map();
  private networkRangeRequests = 0;

  constructor(
    public readonly databaseUrl: string,
    options: {
      pageSize?: number;
      maxCachedPages?: number;
      fetchImpl?: typeof fetch;
    } = {}
  ) {
    this.pageSize = options.pageSize ?? 4096;
    this.maxCachedPages = options.maxCachedPages ?? 64;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Total HTTP Range requests issued (excluding cache hits). */
  public get rangeRequestCount(): number {
    return this.networkRangeRequests;
  }

  /** Clear the in-memory page cache. */
  public clearCache(): void {
    this.pageCache.clear();
  }

  /**
   * Fetch a single `pageSize`-aligned page by 0-based `pageNumber` using `Range: bytes=start-end`.
   */
  public async readPageBytes(pageNumber: number): Promise<Uint8Array> {
    if (this.pageCache.has(pageNumber)) {
      const hit = this.pageCache.get(pageNumber)!;
      this.pageCache.delete(pageNumber);
      this.pageCache.set(pageNumber, hit);
      return hit;
    }

    const startByte = pageNumber * this.pageSize;
    const endByte = startByte + this.pageSize - 1;
    this.networkRangeRequests += 1;

    const res = await this.fetchImpl(this.databaseUrl, {
      headers: {
        Range: `bytes=${startByte}-${endByte}`,
      },
    });

    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP Range request failed for page ${pageNumber} (HTTP ${res.status})`);
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    const pageBytes = buf.byteLength > this.pageSize ? buf.subarray(0, this.pageSize) : buf;

    if (this.pageCache.size >= this.maxCachedPages) {
      const oldestKey = this.pageCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.pageCache.delete(oldestKey);
      }
    }
    this.pageCache.set(pageNumber, pageBytes);
    return pageBytes;
  }

  /**
   * Read `[offset, offset + length)` across one or more cached pages.
   */
  public async readBytes(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    const startPage = Math.floor(offset / this.pageSize);
    const endPage = Math.floor((offset + length - 1) / this.pageSize);

    const out = new Uint8Array(length);
    let written = 0;

    for (let p = startPage; p <= endPage; p++) {
      const page = await this.readPageBytes(p);
      const pageStartOffset = p * this.pageSize;
      const sliceStart = Math.max(0, offset - pageStartOffset);
      const sliceEnd = Math.min(page.byteLength, offset + length - pageStartOffset);
      if (sliceEnd > sliceStart) {
        const chunk = page.subarray(sliceStart, sliceEnd);
        out.set(chunk, written);
        written += chunk.byteLength;
      }
    }

    return written === length ? out : out.subarray(0, written);
  }
}
