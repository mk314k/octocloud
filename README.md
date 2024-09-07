# octocloud

`octocloud` is a zero-dependency TypeScript SDK that uses a user's GitHub account and public repository as a client-side authentication provider, structured file/table store, encrypted secret vault, append-only ledger, and P2P/federated multiplayer backend for static web applications.

## Design Overview

- **Least-privilege OAuth scope (`oauthScope: 'public_repo'`)**: Defaults to `public_repo` rather than `repo` so browser sessions cannot read or modify private repositories. Also supports Fine-Grained Personal Access Tokens (`github_pat_...`) scoped to a single workspace repository.
- **Repository write sandbox**: Rejects writes to `<username>.github.io` repositories, configured `protectedRepos`, or paths containing `.` / `..` segments. Setting `strictRepoSandbox: true` restricts writes to `allowedRepos`.
- **Session storage**: Persists session state in `sessionStorage` by default (`persistence: 'session'`), with `'local'` and `'memory'` options.
- **CDN reads, conditional requests, and batch commits**:
  - `readPublicFile()` and `readPublicJSON()` read from `raw.githubusercontent.com` first with fallback to the REST Contents API.
  - `readFile()` caches response `ETag` headers and sends `If-None-Match` on subsequent reads.
  - `writeFile()` refreshes the remote blob SHA and retries once on HTTP `409` / `422` conflicts.
  - `commitBatch()` writes or deletes multiple files in a single commit via the Git Data API (`git/trees` -> `git/commits` -> `git/refs`).
  - `proposeFileChangeViaPR()` forks an upstream repository, commits a file to a branch on the fork, and opens a pull request.

## Installation

```bash
npm install octocloud
```

## Usage

### Authentication and File Storage (`GitCloudAuth`, `GitRepoStore`, `GitAuthModal`)

```typescript
import { GitCloudAuth, GitRepoStore, GitAuthModal } from 'octocloud';

const auth = new GitCloudAuth({
  defaultRepo: 'MyApp_Workspace',
  extensions: ['.json', '.md'],
  strictRepoSandbox: true,
});

const store = new GitRepoStore(auth);

const modal = new GitAuthModal(auth, {
  onSuccess: async (profile) => {
    console.log(`Authenticated as ${profile.username} (${profile.mode})`);
  },
});
modal.open('#dialogBox');

await store.writeFile('notes.md', '# Notes\nStored in repository.');
const text = await store.readFile('notes.md');

// Read public JSON via raw.githubusercontent.com with REST API fallback
const publicConfig = await store.readPublicJSON('config.json', {
  owner: 'mk314k',
  repo: 'MyApp_Workspace',
});

// Commit multiple file changes in a single Git commit
await store.commitBatch([
  { path: 'data/a.json', content: '{"a":1}' },
  { path: 'data/b.json', content: '{"b":2}' },
], 'Batch update data files');
```

### Tables, Vector Search, and Multi-Repo Queries (`GitTable`)

```typescript
import { GitTable } from 'octocloud';

interface ClaimRow {
  id: string;
  text: string;
  embedding: number[];
  updatedAt?: number;
}

const claims = new GitTable<ClaimRow>(store, 'claims', {
  storageMode: 'indexed-sharded', // writes tables/claims/rows/<id>.json + tables/claims.index.json
  enforceRowOwnership: true,
});

await claims.insert({
  id: 'c1',
  text: 'Water boils at 100C at standard atmospheric pressure',
  embedding: [0.91, 0.12, 0.04],
});

// Query across multiple repository owners and rank by cosine similarity
const matches = await claims.federatedSelect(['alice', 'bob', 'mk314k'], {
  similarity: {
    field: 'embedding',
    vector: [0.9, 0.1, 0.05],
    threshold: 0.8,
    topK: 5,
  },
});
```

### Client-Side Encrypted Vault and Optimistic Sync Queue (`GitEncryptedStore`, `GitSyncQueue`)

```typescript
import { GitEncryptedStore, GitSyncQueue } from 'octocloud';

// PBKDF2-HMAC-SHA256 + AES-GCM-256 encrypted secrets stored in vault/<name>.enc.json
const vault = new GitEncryptedStore(store);
await vault.writeSecretJSON('api-keys', { groqKey: 'gsk_...' }, 'passphrase');
const keys = await vault.readSecretJSON<{ groqKey: string }>('api-keys', 'passphrase');

// Coalesce local writes and flush in a single commitBatch() call
const syncQueue = new GitSyncQueue(store);
syncQueue.enqueueJSON('state/draft.json', { step: 1 });
syncQueue.enqueueJSON('state/draft.json', { step: 2 });
await syncQueue.flush();
```

### Hash-Chained Ledger and Peer Consensus (`GitLedger`, `PeerConsensusEngine`)

```typescript
import { GitLedger, generateLedgerKeyPair, PeerConsensusEngine } from 'octocloud';

const ledger = new GitLedger<{ subjectId: string; outcome: string }>(store, 'audit-log');
const signer = await generateLedgerKeyPair();

await ledger.append({ subjectId: 'claim_1', outcome: 'fact' }, { signer });
const verification = await ledger.verifyChain();
// verification => { valid: true, entryCount: 1, merkleRoot: '...' }

const consensus = new PeerConsensusEngine<'fact' | 'misleading' | 'false'>();
const { subjects, credibility } = consensus.computeNetworkState([
  { id: 'v1', subjectId: 'claim_1', voter: 'alice', outcome: 'fact', evidenceUrl: 'https://nasa.gov', timestamp: 1000 },
  { id: 'v2', subjectId: 'claim_1', voter: 'bob', outcome: 'fact', timestamp: 1100 },
]);
```

### Partitioned Page Shards and HTTP Range Reader (`GitPartitionedEngine`, `GitSqliteVfs`)

```typescript
import { GitPartitionedEngine, GitSqliteVfs } from 'octocloud';

const engine = new GitPartitionedEngine<{ id: string; title: string; vec: number[] }>(store, 'docs', {
  pageSize: 100,
  textIndexFields: ['title'],
  vectorField: 'vec',
});

await engine.buildFromRows(rows);
const doc = await engine.getById('doc_42'); // loads manifest.json + 1 page shard
const results = await engine.searchText('quantum entanglement');

// Read 4KB pages over HTTP Range with an in-memory LRU cache
const vfs = new GitSqliteVfs('https://example.github.io/data/index.sqlite');
const header = await vfs.readBytes(0, 100);
```

### Federated Pub/Sub and Multiplayer (`GitChannel`, `GitPeerRoom`, `GitRepoRoom`)

```typescript
import { GitChannel, GitPeerRoom, GitRepoRoom } from 'octocloud';

const channel = new GitChannel<{ text: string }>(store, 'lobby');
await channel.publish('CHAT', { text: 'ready' });
const { newMessages, presence } = await channel.pollPeers(['peer_username']);

// WebRTC P2P room with signaling exchanged over GitChannel
const peerRoom = new GitPeerRoom<{ x: number; y: number }>(auth, 'arena-1');
await channel.negotiateWebRTCPeer(peerRoom, 'peer_username', 'initiator');

// Turn-based match synced across player repositories
const matchRoom = new GitRepoRoom<{ moves: string[] }>(store, 'chess-1');
await matchRoom.submitMove({ moves: ['e2e4', 'e7e5'] }, 'peer_username', 'e7e5', ['peer_username']);
```

## Development

```bash
npm install
npm test
npm run build
```

## License

MIT
