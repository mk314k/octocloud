/**
 * Serverless Relational / Collection Table Engine (`GitTable<Row>`) in `octocloud`.
 *
 * Allows static web apps and games to store structured relational tables inside a GitHub repository
 * (`tables/<tableName>.json`).
 *
 * Supports:
 *   - `insert`, `upsert`, `findById`, `select` (`where`, `orderBy`, `desc`, `limit`, `offset`)
 *   - `update`, `delete`
 */
import { GitRepoStore, sanitizeRepoPath } from './store';

export interface TableRow {
  id: string;
  owner?: string;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface SelectQuery<Row extends TableRow> {
  where?: (row: Row) => boolean;
  orderBy?: keyof Row;
  desc?: boolean;
  limit?: number;
  offset?: number;
}

export class GitTable<Row extends TableRow = TableRow> {
  public readonly tableName: string;

  constructor(
    public readonly store: GitRepoStore,
    tableName: string
  ) {
    const cleanName = sanitizeRepoPath(tableName).replace(/\//g, '_');
    this.tableName = cleanName;
  }

  private get collectionPath(): string {
    return `tables/${this.tableName}.json`;
  }

  private async loadAllRows(): Promise<Row[]> {
    try {
      const rows = await this.store.readJSON<Row[]>(this.collectionPath);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  private async saveCollectionRows(rows: Row[], message: string): Promise<void> {
    await this.store.writeJSON(this.collectionPath, rows, message);
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
      owner: row.owner ?? this.store.auth.username,
      createdAt: row.createdAt ?? now,
      updatedAt: now,
    };

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
      return (await this.update(row.id, row)) as Row;
    }
    return this.insert(row);
  }

  /**
   * Find a single row by its primary `id`.
   */
  public async findById(id: string): Promise<Row | null> {
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
   * Update an existing row by `id`.
   */
  public async update(id: string, patch: Partial<Row>): Promise<Row | null> {
    const rows = await this.loadAllRows();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;

    const existing = rows[idx];
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
   * Delete a row by `id`.
   */
  public async delete(id: string): Promise<boolean> {
    const rows = await this.loadAllRows();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return false;

    rows.splice(idx, 1);
    await this.saveCollectionRows(rows, `Delete row ${id} from ${this.tableName}`);
    return true;
  }
}
