# OctoCloud

**`octocloud`** is a zero-dependency **Serverless GitHub Authentication, Sandboxed Cloud Repository File & Table Store, and Verified Multiplayer SDK** for static web applications and browser games hosted on **GitHub Pages** (or any static host).

It turns a user's own GitHub account and public workspace repository into a free, zero-backend authentication provider, cloud file/table store, and multiplayer game lobby—without ever exposing private repositories.

## Security-First Architecture

1. **Private Repositories Are Never Exposed (`oauthScope: 'public_repo'`)**:
   - Defaults to GitHub's `public_repo` OAuth scope rather than `repo`, ensuring the browser token **cannot read or modify any private repositories**.
   - Supports Fine-Grained Personal Access Tokens (`github_pat_...`) scoped to a single workspace repository.
2. **Repository Write Sandbox & Path Traversal Protection**:
   - Automatically blocks writes to `<username>.github.io` sites, `protectedRepos`, or any path containing `..` traversal segments.
   - Supports `strictRepoSandbox: true` to lock all file writes strictly to `allowedRepos`.
3. **Ephemeral `sessionStorage` Persistence by Default**:
   - Tokens are stored in `sessionStorage` (`persistence: 'session'`) by default and wiped as soon as the tab closes.
4. **Anti-Spoofing Multiplayer Session Proofs & Dual-Repo Federation**:
   - Tokens are **never** shared between players.
   - In WebRTC P2P mode (`GitPeerRoom`), players can publish a `SessionProof` to their own repo (`publishIdentityProof`) and peers verify ownership directly against GitHub's API (`verifyPeerIdentity`).
   - In Turn-Based Repo mode (`GitRepoRoom`), **Dual-Repo Federation** lets Player 1 write moves to `Player1/<repo>` and Player 2 write moves to `Player2/<repo>`, while both read each other's public repo to sync the latest move version!

---

## Installation

```bash
npm install octocloud
```

---

## Quickstart Usage

### 1. Authenticate & Read/Write Cloud Files (`GitCloudAuth` + `GitRepoStore`)

```typescript
import { GitCloudAuth, GitRepoStore, GitAuthModal } from 'octocloud';

const auth = new GitCloudAuth({
  defaultRepo: 'MyApp_Workspace',
  extensions: ['.json', '.md'],
  strictRepoSandbox: true, // Only allow writing to MyApp_Workspace
});

const store = new GitRepoStore(auth);

// Mount the drop-in Login Modal (OAuth, Fine-Grained PAT, or Read-Only Username)
const modal = new GitAuthModal(auth, {
  onSuccess: async (profile) => {
    console.log(`Logged in as ${profile.username} (${profile.mode})`);
    const files = await store.fetchAllFiles(); // Map<filename, content>
  },
});
modal.open('#dialogBox');

// Save and read UTF-8 files or JSON objects (automatically tracks GitHub blob SHAs)
await store.writeFile('notes.md', '# Hello World\nSaved in GitHub!');
const content = await store.readFile('notes.md');
```

### 2. Structured Relational Tables (`GitTable`)

```typescript
import { GitTable } from 'octocloud';

const scores = new GitTable<{ id: string; userId: string; score: number }>(store, 'scores', {
  storageMode: 'sharded',       // Stores each row in tables/scores/rows/<id>.json
  enforceRowOwnership: true,    // Users can only update/delete their own rows
});

await scores.insert({ id: 'row_1', userId: 'u1', score: 950 });

const topScores = await scores.select({
  where: (r) => r.score >= 500,
  orderBy: 'score',
  desc: true,
  limit: 10,
});
```

### 3. Multiplayer Games (`GitPeerRoom` & Federated `GitRepoRoom`)

```typescript
import { GitPeerRoom, GitRepoRoom } from 'octocloud';

// Mode A: Real-Time WebRTC P2P Room with Anti-Spoofing Proof
const p2pRoom = new GitPeerRoom<{ x: number; y: number }>(auth, 'arena-1');
await p2pRoom.publishIdentityProof(store);

p2pRoom.onMessage((msg) => {
  console.log(`[seq #${msg.seq}] ${msg.sender.username} moved to`, msg.payload);
});

// Mode B: Dual-Repo Turn-Based Match (Zero Shared Tokens!)
const matchRoom = new GitRepoRoom<{ moves: string[] }>(store, 'chess-match-1');
await matchRoom.submitMove({ moves: ['e2e4', 'e7e5'] }, 'opponent_github', 'e7e5', ['opponent_github']);
```

---

## Development & Testing

```bash
npm install
npm test
npm run build
```

## License

MIT
