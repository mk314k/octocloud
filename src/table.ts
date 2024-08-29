/**
 * Serverless Relational / Collection Table Engine (`GitTable<Row>`) in `octocloud`.
 *
 * Allows static web apps and games to store structured relational tables inside a GitHub repository
 * (`tables/<tableName>.json` or row-sharded `tables/<tableName>/rows/<id>.json`).
 *
 * Supports:
 *   - `insert`, `upsert`, `findById`, `select` (`where`, `orderBy`, `desc`, `limit`, `offset`)
 *   - `update`, `delete`
 *   - Row-Level Ownership (`enforceRowOwnership: true` stamps `owner` with the authenticated GitHub username
 *     and prevents users from modifying or deleting rows owned by someone else)
 *   - `innerJoin` across two `GitTable` instances
 */
import { GitRepoStore, sanitizeRepoPath } from './store';

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
   * - `'collection'` (default): stores all rows in `tables/<tableName>.json` (fast single-fetch reads)
   * - `'sharded'`: stores each row in its own file `tables/<tableName>/rows/<id>.json` (avoids multi-user write conflicts!)
   */
  storageMode?: 'collection' | 'sharded';
  /**
   * When true, stamps `row.owner = auth.username` on insert and blocks updates/deletes
   * if `existingRow.owner !== auth.username`.
   */
  enforceRowOwnership?: boolean;
  /** Optional repository owner override (for reading public shared tables hosted by the app developer) */
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

  private getRowPath(id: string): string {
    const safeId = sanitizeRepoPath(id).replace(/\//g, '_');
    return `tables/${this.tableName}/rows/${safeId}.json`;
  }

  private async loadAllRows(): Promise<Row[]> {
    if (this.options.storageMode === 'sharded') {
      try {
        const entries = await this.store.listFiles(
          `tables/${this.tableName}/rows`,
          this.options.ownerOverride,
          this.options.repoOverride
        );
        const jsonEntries = entries.filter((entry) => entry.name.endsWith('.json'));
        const rows: Array<Row | null> = await Promise.all(
          jsonEntries.map((entry) =>
            this.store.readJSON<Row>(
              entry.path,
              this.options.ownerOverride,
              this.options.repoOverride
            ).catch(() => null)
          )
        );
        return rows.filter((r): r is Row => r !== null);
      } catch {
        return [];
      }
    }

    try {
      const rows = await this.store.readJSON<Row[]>(
        this.collectionPath,
        this.options.ownerOverride,
        this.options.repoOverride
      );
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  private async saveCollectionRows(rows: Row[], message: string): Promise<void> {
    await this.store.writeJSON(this.collectionPath, rows, message);
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

  /**
   * Insert a new row into the table. Throws if a row with the same `id` already exists.
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

    if (this.options.storageMode === 'sharded') {
      const existing = await this.findById(row.id);
      if (existing) {
        throw new Error(`Row with id "${row.id}" already exists in table "${this.tableName}"`);
      }
      await this.store.writeJSON(
        this.getRowPath(row.id),
        stamped,
        `Insert row ${row.id} into ${this.tableName}`
      );
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
   * Insert or update a row in the table (`upsert`).
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
   * Find a single row by its primary `id`.
   */
  public async findById(id: string): Promise<Row | null> {
    if (this.options.storageMode === 'sharded') {
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

  /**
   * Query rows from the table using optional `where`, `orderBy`, `desc`, `offset`, and `limit` clauses.
   */
  public async select(query: SelectQuery<Row> = {}): Promise<Row[]> {
    let rows = await this.loadAllRows();

    if (query.where) {
      rows = rows.filter(query.where);
    }

    if (query.orderBy !== undefined) {
      const key = query.orderBy;
      const dir = query.desc ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const va = a[key] as string | number;
        const vb = b[key] as string | number;
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      });
    }

    const start = query.offset ?? 0;
    const end = query.limit !== undefined ? start + query.limit : undefined;
    return rows.slice(start, end);
  }

  /**
   * Update an existing row by `id`. Respects `enforceRowOwnership` if enabled.
   */
  public async update(id: string, patch: Partial<Row>): Promise<Row | null> {
    if (this.options.storageMode === 'sharded') {
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
      return updated;
    }

    const rows = await this.loadAllRows();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;

    const existing = rows[idx];
    this.assertOwnershipPermission(existing);

    const updated: Row = {
      ...existing,
      ...patch,
      id: existing.id,
      owner: existing.owner,
      updatedAt: Date.now(),
    };
    rows[idx] = updated;
    await this.saveCollectionRows(rows, `Update row ${id} in ${this.tableName}`);
    return updated;
  }

  /**
   * Delete a row by `id`. Respects `enforceRowOwnership` if enabled.
   */
  public async delete(id: string): Promise<boolean> {
    if (this.options.storageMode === 'sharded') {
      const existing = await this.findById(id);
      if (!existing) return false;
      this.assertOwnershipPermission(existing);
      await this.store.deleteFile(this.getRowPath(id), `Delete row ${id} from ${this.tableName}`);
      return true;
    }

    const rows = await this.loadAllRows();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return false;

    this.assertOwnershipPermission(rows[idx]);
    rows.splice(idx, 1);
    await this.saveCollectionRows(rows, `Delete row ${id} from ${this.tableName}`);
    return true;
  }

  /**
   * Perform an in-memory relational INNER JOIN with another `GitTable` on matching keys.
   */
  public async innerJoin<OtherRow extends TableRow, Result = { left: Row; right: OtherRow }>(
    otherTable: GitTable<OtherRow>,
    leftKey: keyof Row,
    rightKey: keyof OtherRow,
    project?: (left: Row, right: OtherRow) => Result
  ): Promise<Result[]> {
    const [leftRows, rightRows] = await Promise.all([
      this.select(),
      otherTable.select(),
    ]);

    const rightIndex = new Map<unknown, OtherRow[]>();
    for (const r of rightRows) {
      const k = r[rightKey];
      const bucket = rightIndex.get(k) ?? [];
      bucket.push(r);
      rightIndex.set(k, bucket);
    }

    const results: Result[] = [];
    for (const l of leftRows) {
      const matches = rightIndex.get(l[leftKey]);
      if (matches) {
        for (const r of matches) {
          results.push(project ? project(l, r) : ({ left: l, right: r } as unknown as Result));
        }
      }
    }
    return results;
  }
}
