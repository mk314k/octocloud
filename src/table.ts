/**
 * Structured table storage (`GitTable<Row>`) backed by GitHub repository JSON files.
 *
 * Supports three storage layouts:
 *   - `'collection'`: single `tables/<tableName>.json` file.
 *   - `'sharded'`: one file per row under `tables/<tableName>/rows/<id>.json`.
 *   - `'indexed-sharded'`: per-row files plus a compacted `tables/<tableName>.index.json` snapshot.
 */
import { GitRepoStore, sanitizeRepoPath } from './store.js';

export interface TableRow {
  id: string;
  owner?: string;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface VectorSimilarityClause<Row extends TableRow> {
  /** Row property containing a `number[]` embedding */
  field: keyof Row;
  /** Query vector (`number[]`) */
  vector: number[];
  /** Minimum cosine similarity in [-1, 1] (default: 0.5) */
  threshold?: number;
  /** Maximum number of matches to return */
  topK?: number;
}

export interface SelectQuery<Row extends TableRow> {
  where?: (row: Row) => boolean;
  similarity?: VectorSimilarityClause<Row>;
  orderBy?: keyof Row;
  desc?: boolean;
  limit?: number;
  offset?: number;
}

export interface GitTableOptions {
  /**
   * Storage layout:
   * - `'collection'` (default): stores all rows in `tables/<tableName>.json`
   * - `'sharded'`: stores each row in `tables/<tableName>/rows/<id>.json`
   * - `'indexed-sharded'`: writes per-row files and maintains `tables/<tableName>.index.json`
   */
  storageMode?: 'collection' | 'sharded' | 'indexed-sharded';
  /**
   * Stamp `row.owner = auth.username` on insert and reject updates/deletes
   * when `existingRow.owner !== auth.username`.
   */
  enforceRowOwnership?: boolean;
  /** Optional repository owner override for reading public tables */
  ownerOverride?: string;
  /** Optional repository name override */
  repoOverride?: string;
}

/**
 * Cosine similarity in [-1, 1] between two numeric vectors.
 * Returns 0 for empty, unequal-length, or zero-norm inputs.
 */
export function cosineSimilarity(vecA: readonly number[], vecB: readonly number[]): number {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class GitTable<Row extends TableRow = TableRow> {
  public readonly tableName: string;
  public readonly options: Required<Omit<GitTableOptions, 'ownerOverride' | 'repoOverride'>> & {
    ownerOverride?: string;
    repoOverride?: string;
  };

  constructor(
    public readonly store: GitRepoStore,
    tableName: string,
    options: GitTableOptions = {}
  ) {
    const cleanName = sanitizeRepoPath(tableName).replace(/\//g, '_');
    this.tableName = cleanName;
    this.options = {
      storageMode: options.storageMode ?? 'collection',
      enforceRowOwnership: options.enforceRowOwnership ?? false,
      ownerOverride: options.ownerOverride,
      repoOverride: options.repoOverride,
    };
  }

  private get collectionPath(): string {
    return `tables/${this.tableName}.json`;
  }

  private get indexPath(): string {
    return `tables/${this.tableName}.index.json`;
  }

  private getRowPath(id: string): string {
    const safeId = sanitizeRepoPath(id).replace(/\//g, '_');
    return `tables/${this.tableName}/rows/${safeId}.json`;
  }

  private async loadShardedRowsFromOwner(ownerOverride?: string, repoOverride?: string): Promise<Row[]> {
    try {
      const entries = await this.store.listFiles(
        `tables/${this.tableName}/rows`,
        ownerOverride,
        repoOverride
      );
      const jsonEntries = entries.filter((entry) => entry.name.endsWith('.json'));
      const rows: Array<Row | null> = await Promise.all(
        jsonEntries.map((entry) =>
          this.store.readJSON<Row>(entry.path, ownerOverride, repoOverride).catch(() => null)
        )
      );
      return rows.filter((r): r is Row => r !== null);
    } catch {
      return [];
    }
  }

  private async loadAllRows(ownerOverride = this.options.ownerOverride, repoOverride = this.options.repoOverride): Promise<Row[]> {
    if (this.options.storageMode === 'indexed-sharded') {
      try {
        const indexed = await this.store.readJSON<Row[]>(this.indexPath, ownerOverride, repoOverride);
        if (Array.isArray(indexed)) {
          return indexed;
        }
      } catch {
        // Fall back to reading row directory if index file is not present
      }
      return this.loadShardedRowsFromOwner(ownerOverride, repoOverride);
    }

    if (this.options.storageMode === 'sharded') {
      return this.loadShardedRowsFromOwner(ownerOverride, repoOverride);
    }

    try {
      const rows = await this.store.readJSON<Row[]>(
        this.collectionPath,
        ownerOverride,
        repoOverride
      );
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  private async saveCollectionRows(rows: Row[], message: string): Promise<void> {
    await this.store.writeJSON(this.collectionPath, rows, message);
  }

  /**
   * Rebuild `tables/<tableName>.index.json` from all sharded row files.
   */
  public async compactIndex(): Promise<Row[]> {
    const rows = await this.loadShardedRowsFromOwner(this.options.ownerOverride, this.options.repoOverride);
    await this.store.writeJSON(this.indexPath, rows, `Compact index for ${this.tableName}`);
    return rows;
  }

  private assertOwnershipPermission(existingRow: Row): void {
    if (!this.options.enforceRowOwnership) return;
    const currentUser = this.store.auth.username;
    if (
      existingRow.owner &&
      currentUser &&
      existingRow.owner.toLowerCase() !== currentUser.toLowerCase()
    ) {
      throw new Error(
        `Row-Level Security: User "${currentUser}" cannot modify row "${existingRow.id}" owned by "${existingRow.owner}"`
      );
    }
  }

  private get isShardedWrite(): boolean {
    return this.options.storageMode === 'sharded' || this.options.storageMode === 'indexed-sharded';
  }

  /**
   * Insert a new row. Throws if a row with the same `id` already exists.
   */
  public async insert(row: Row): Promise<Row> {
    if (!row.id || typeof row.id !== 'string') {
      throw new Error('Table row must have a non-empty string "id"');
    }

    const now = Date.now();
    const stamped: Row = {
      ...row,
      owner: this.options.enforceRowOwnership
        ? this.store.auth.username || row.owner
        : row.owner ?? this.store.auth.username,
      createdAt: row.createdAt ?? now,
      updatedAt: now,
    };

    if (this.isShardedWrite) {
      const existing = await this.findById(row.id);
      if (existing) {
        throw new Error(`Row with id "${row.id}" already exists in table "${this.tableName}"`);
      }
      await this.store.writeJSON(
        this.getRowPath(row.id),
        stamped,
        `Insert row ${row.id} into ${this.tableName}`
      );
      if (this.options.storageMode === 'indexed-sharded') {
        await this.compactIndex();
      }
      return stamped;
    }

    const rows = await this.loadAllRows();
    if (rows.some((r) => r.id === row.id)) {
      throw new Error(`Row with id "${row.id}" already exists in table "${this.tableName}"`);
    }
    rows.push(stamped);
    await this.saveCollectionRows(rows, `Insert row ${row.id} into ${this.tableName}`);
    return stamped;
  }

  /**
   * Insert or update a row by `id`.
   */
  public async upsert(row: Row): Promise<Row> {
    const existing = await this.findById(row.id);
    if (existing) {
      this.assertOwnershipPermission(existing);
      return (await this.update(row.id, row)) as Row;
    }
    return this.insert(row);
  }

  /**
   * Look up a single row by primary `id`.
   */
  public async findById(id: string): Promise<Row | null> {
    if (this.isShardedWrite) {
      try {
        return await this.store.readJSON<Row>(
          this.getRowPath(id),
          this.options.ownerOverride,
          this.options.repoOverride
        );
      } catch {
        return null;
      }
    }

    const rows = await this.loadAllRows();
    return rows.find((r) => r.id === id) ?? null;
  }

  private applyQueryPipeline(rows: Row[], query: SelectQuery<Row>): Array<Row & { _similarity?: number }> {
    let result: Array<Row & { _similarity?: number }> = [...rows];

    if (query.where) {
      result = result.filter(query.where);
    }

    if (query.similarity) {
      const { field, vector, threshold = 0.5, topK } = query.similarity;
      const scored: Array<Row & { _similarity: number }> = [];
      for (const row of result) {
        const candidateVec = row[field];
        if (Array.isArray(candidateVec)) {
          const sim = cosineSimilarity(vector, candidateVec as number[]);
          if (sim >= threshold) {
            scored.push({ ...row, _similarity: sim });
          }
        }
      }
      scored.sort((a, b) => b._similarity - a._similarity);
      result = topK !== undefined ? scored.slice(0, topK) : scored;
    }

    if (query.orderBy !== undefined) {
      const key = query.orderBy;
      const dir = query.desc ? -1 : 1;
      result = [...result].sort((a, b) => {
        const va = a[key] as string | number;
        const vb = b[key] as string | number;
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      });
    }

    const start = query.offset ?? 0;
    const end = query.limit !== undefined ? start + query.limit : undefined;
    return result.slice(start, end);
  }

  /**
   * Query rows using optional `where`, `similarity`, `orderBy`, `desc`, `offset`, and `limit` clauses.
   */
  public async select(query: SelectQuery<Row> = {}): Promise<Array<Row & { _similarity?: number }>> {
    const rows = await this.loadAllRows();
    return this.applyQueryPipeline(rows, query);
  }

  /**
   * Query and merge rows across multiple repository owners in parallel.
   * Rows sharing the same `id` are deduplicated by highest `updatedAt`.
   */
  public async federatedSelect(
    owners: string[],
    query: SelectQuery<Row> = {},
    repoOverride = this.options.repoOverride || this.store.auth.repo
  ): Promise<Array<Row & { _similarity?: number }>> {
    const uniqueOwners = Array.from(new Set(owners.map((o) => o.trim()).filter(Boolean)));
    const perOwnerLists = await Promise.all(
      uniqueOwners.map((owner) => this.loadAllRows(owner, repoOverride).catch(() => [] as Row[]))
    );

    const mergedById = new Map<string, Row>();
    for (const list of perOwnerLists) {
      for (const row of list) {
        if (!row || typeof row.id !== 'string') continue;
        const prev = mergedById.get(row.id);
        if (!prev || (row.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
          mergedById.set(row.id, row);
        }
      }
    }

    return this.applyQueryPipeline(Array.from(mergedById.values()), query);
  }

  /**
   * Update an existing row by `id`. Enforces row ownership when `enforceRowOwnership` is enabled.
   */
  public async update(id: string, patch: Partial<Row>): Promise<Row | null> {
    if (this.isShardedWrite) {
      const existing = await this.findById(id);
      if (!existing) return null;
      this.assertOwnershipPermission(existing);

      const updated: Row = {
        ...existing,
        ...patch,
        id: existing.id,
        owner: existing.owner,
        updatedAt: Date.now(),
      };
      await this.store.writeJSON(
        this.getRowPath(id),
        updated,
        `Update row ${id} in ${this.tableName}`
      );
      if (this.options.storageMode === 'indexed-sharded') {
        await this.compactIndex();
      }
      return updated;
    }

    const rows = await this.loadAllRows();
    const index = rows.findIndex((r) => r.id === id);
    if (index === -1) return null;

    const existing = rows[index];
    this.assertOwnershipPermission(existing);

    const updated: Row = {
      ...existing,
      ...patch,
      id: existing.id,
      owner: existing.owner,
      updatedAt: Date.now(),
    };
    rows[index] = updated;
    await this.saveCollectionRows(rows, `Update row ${id} in ${this.tableName}`);
    return updated;
  }

  /**
   * Delete a row by `id`. Enforces row ownership when `enforceRowOwnership` is enabled.
   */
  public async delete(id: string): Promise<boolean> {
    if (this.isShardedWrite) {
      const existing = await this.findById(id);
      if (!existing) return false;
      this.assertOwnershipPermission(existing);
      await this.store.deleteFile(
        this.getRowPath(id),
        `Delete row ${id} from ${this.tableName}`
      );
      if (this.options.storageMode === 'indexed-sharded') {
        await this.compactIndex();
      }
      return true;
    }

    const rows = await this.loadAllRows();
    const index = rows.findIndex((r) => r.id === id);
    if (index === -1) return false;

    this.assertOwnershipPermission(rows[index]);
    rows.splice(index, 1);
    await this.saveCollectionRows(rows, `Delete row ${id} from ${this.tableName}`);
    return true;
  }

  /**
   * Inner join between this table and `otherTable` on `localKey === foreignKey`.
   */
  public async innerJoin<OtherRow extends TableRow, Joined>(
    otherTable: GitTable<OtherRow>,
    localKey: keyof Row,
    foreignKey: keyof OtherRow,
    selectJoined: (localRow: Row, otherRow: OtherRow) => Joined
  ): Promise<Joined[]> {
    const [localRows, otherRows] = await Promise.all([
      this.select(),
      otherTable.select(),
    ]);

    const results: Joined[] = [];
    for (const lRow of localRows) {
      for (const oRow of otherRows) {
        if (lRow[localKey] !== undefined && lRow[localKey] === oRow[foreignKey]) {
          results.push(selectJoined(lRow, oRow));
        }
      }
    }
    return results;
  }
}
