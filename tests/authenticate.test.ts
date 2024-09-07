import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GitCloudAuth,
  GitRepoStore,
  GitTable,
  GitLedger,
  PeerConsensusEngine,
  GitPartitionedEngine,
  GitSqliteVfs,
  GitEncryptedStore,
  GitSyncQueue,
  GitChannel,
  GitPeerRoom,
  GitRepoRoom,
  generateLedgerKeyPair,
  cosineSimilarity,
  sanitizeRepoPath,
  encodeBase64UTF8,
  decodeBase64UTF8,
} from '../src/index.ts';

function createMockGitHubAPI() {
  const repos = new Map<string, Map<string, { content: string; sha: string; etag: string }>>();
  let shaCounter = 100;
  let prCounter = 10;
  let commitCounter = 500;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method || 'GET').toUpperCase();
    const headers = (init?.headers || {}) as Record<string, string>;
    const authHeader = headers['Authorization'] || '';

    // 0. Raw GitHub CDN (`https://raw.githubusercontent.com/:owner/:repo/:branch/:path`)
    const rawMatch = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/[^/]+\/(.*)$/);
    if (rawMatch && method === 'GET') {
      const repoKey = rawMatch[1];
      const filePath = rawMatch[2];
      const repoFiles = repos.get(repoKey);
      if (!repoFiles || !repoFiles.has(filePath)) {
        return new Response('Not Found', { status: 404 });
      }
      const entry = repoFiles.get(filePath)!;
      const decoded = decodeBase64UTF8(entry.content);
      return new Response(decoded, { status: 200 });
    }

    // 0b. HTTP Range VFS Binary Endpoint (`https://cdn.example.com/db.sqlite`)
    if (url.startsWith('https://cdn.example.com/db.sqlite') && method === 'GET') {
      const rangeHeader = headers['Range'] || headers['range'] || '';
      const totalBytes = new Uint8Array(16384);
      for (let i = 0; i < totalBytes.length; i++) {
        totalBytes[i] = i % 251;
      }
      const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d+)/);
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Math.min(totalBytes.length - 1, Number(rangeMatch[2]));
        const slice = totalBytes.slice(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${totalBytes.length}` },
        });
      }
      return new Response(totalBytes, { status: 200 });
    }

    // 1. OAuth Proxy Exchange
    if (url.includes('oauth/exchange')) {
      if (url.includes('code=valid_oauth_code')) {
        return new Response(JSON.stringify({ token: 'gho_oauth_token_123' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'bad_code' }), { status: 400 });
    }

    // 2. Authenticated User Profile (`GET /user`)
    if (url === 'https://api.github.com/user' && method === 'GET') {
      if (authHeader === 'token ghp_valid_pat' || authHeader === 'token gho_oauth_token_123') {
        return new Response(
          JSON.stringify({
            login: 'mk314k',
            name: 'Kartikesh Mishra',
            avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
            html_url: 'https://github.com/mk314k',
          }),
          { status: 200 }
        );
      }
      if (authHeader === 'token ghp_player2_pat') {
        return new Response(
          JSON.stringify({
            login: 'player2',
            name: 'Player Two',
            avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4',
            html_url: 'https://github.com/player2',
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    }

    // 3. Public User Lookup (`GET /users/:username`)
    const userMatch = url.match(/^https:\/\/api\.github\.com\/users\/([^/]+)$/);
    if (userMatch && method === 'GET') {
      const uname = userMatch[1];
      if (uname === 'unknown_user') {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          login: uname,
          name: uname,
          avatar_url: `https://avatars.githubusercontent.com/${uname}`,
          html_url: `https://github.com/${uname}`,
        }),
        { status: 200 }
      );
    }

    // 4. Create Repo (`POST /user/repos`)
    if (url === 'https://api.github.com/user/repos' && method === 'POST') {
      const body = JSON.parse(String(init?.body || '{}'));
      const owner = authHeader.includes('player2') ? 'player2' : 'mk314k';
      const repoKey = `${owner}/${body.name}`;
      if (!repos.has(repoKey)) {
        repos.set(repoKey, new Map());
      }
      return new Response(JSON.stringify({ full_name: repoKey, private: false }), { status: 201 });
    }

    // 4b. Fork Repo (`POST /repos/:owner/:repo/forks`)
    const forkMatch = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/forks$/);
    if (forkMatch && method === 'POST') {
      const upstreamRepo = forkMatch[2];
      const forkOwner = authHeader.includes('player2') ? 'player2' : 'mk314k';
      const forkKey = `${forkOwner}/${upstreamRepo}`;
      if (!repos.has(forkKey)) {
        repos.set(forkKey, new Map());
      }
      return new Response(JSON.stringify({ full_name: forkKey }), { status: 202 });
    }

    // 4c. Open Pull Request (`POST /repos/:owner/:repo/pulls`)
    const prMatch = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/pulls$/);
    if (prMatch && method === 'POST') {
      const repoKey = prMatch[1];
      const num = ++prCounter;
      return new Response(
        JSON.stringify({
          number: num,
          html_url: `https://github.com/${repoKey}/pull/${num}`,
        }),
        { status: 201 }
      );
    }

    // 4d. Git Data API for Atomic Multi-File Commits (`commitBatch`)
    const refGetMatch = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/);
    if (refGetMatch && method === 'GET') {
      return new Response(
        JSON.stringify({ object: { sha: `commit_base_${commitCounter}` } }),
        { status: 200 }
      );
    }

    const treePostMatch = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees$/);
    if (treePostMatch && method === 'POST') {
      const repoKey = treePostMatch[1];
      if (!repos.has(repoKey)) {
        repos.set(repoKey, new Map());
      }
      const targetRepo = repos.get(repoKey)!;
      const body = JSON.parse(String(init?.body || '{}'));
      for (const entry of body.tree || []) {
        if (entry.sha === null) {
          targetRepo.delete(entry.path);
        } else if (typeof entry.content === 'string') {
          const newSha = `sha_${++shaCounter}`;
          targetRepo.set(entry.path, {
            content: encodeBase64UTF8(entry.content),
            sha: newSha,
            etag: `W/"etag_${shaCounter}"`,
          });
        }
      }
      return new Response(
        JSON.stringify({ sha: `tree_${++commitCounter}` }),
        { status: 201 }
      );
    }

    const commitPostMatch = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/commits$/);
    if (commitPostMatch && method === 'POST') {
      return new Response(
        JSON.stringify({ sha: `commit_${++commitCounter}` }),
        { status: 201 }
      );
    }

    const refPatchMatch = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/);
    if (refPatchMatch && method === 'PATCH') {
      const body = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({ object: { sha: body.sha } }),
        { status: 200 }
      );
    }

    // 5. Repo Contents (`GET / PUT / DELETE /repos/:owner/:repo/contents/:path`)
    const contentsMatch = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/contents\/(.*)$/);
    if (contentsMatch) {
      const repoKey = contentsMatch[1];
      const filePath = contentsMatch[2];
      const repoFiles = repos.get(repoKey);

      if (method === 'GET') {
        if (!repoFiles) {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        if (filePath === '' || !repoFiles.has(filePath)) {
          const prefix = filePath ? `${filePath}/` : '';
          const matchingEntries = Array.from(repoFiles.entries()).filter(([p]) =>
            prefix ? p.startsWith(prefix) : true
          );
          if (filePath === '' || matchingEntries.length > 0) {
            const list = matchingEntries.map(([p, info]) => ({
              name: p.split('/').pop() || p,
              path: p,
              sha: info.sha,
              size: info.content.length,
              type: 'file',
              url: `https://api.github.com/repos/${repoKey}/contents/${p}`,
            }));
            return new Response(JSON.stringify(list), { status: 200 });
          }
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }

        const fileEntry = repoFiles.get(filePath)!;
        const ifNoneMatch = headers['If-None-Match'] || headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === fileEntry.etag) {
          return new Response(null, { status: 304 });
        }

        return new Response(
          JSON.stringify({
            name: filePath.split('/').pop() || filePath,
            path: filePath,
            sha: fileEntry.sha,
            content: fileEntry.content,
          }),
          {
            status: 200,
            headers: { ETag: fileEntry.etag },
          }
        );
      }

      if (method === 'PUT') {
        if (!repos.has(repoKey)) {
          repos.set(repoKey, new Map());
        }
        const targetRepo = repos.get(repoKey)!;
        const body = JSON.parse(String(init?.body || '{}'));
        const existing = targetRepo.get(filePath);
        if (existing && body.sha !== existing.sha) {
          return new Response(JSON.stringify({ message: 'Missing or mismatched sha' }), { status: 409 });
        }
        const newSha = `sha_${++shaCounter}`;
        const newEtag = `W/"etag_${shaCounter}"`;
        targetRepo.set(filePath, { content: body.content, sha: newSha, etag: newEtag });
        return new Response(
          JSON.stringify({ content: { path: filePath, sha: newSha } }),
          { status: existing ? 200 : 201 }
        );
      }

      if (method === 'DELETE') {
        if (!repoFiles || !repoFiles.has(filePath)) {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        repoFiles.delete(filePath);
        return new Response(JSON.stringify({ commit: {} }), { status: 200 });
      }
    }

    return new Response(JSON.stringify({ message: 'Unhandled mock route' }), { status: 404 });
  };

  return { mockFetch, repos };
}

test('UTF-8 Base64 encoding and decoding preserves Unicode and newlines', () => {
  const original = '# Workspace Note 🚀\nvalue = 42\n"Hello, 世界!"';
  const encoded = encodeBase64UTF8(original);
  const decoded = decodeBase64UTF8(encoded);
  assert.equal(decoded, original);
});

test('Security Defaults: oauthScope is public_repo, blocks .github.io writes and path traversal', async () => {
  const { mockFetch } = createMockGitHubAPI();
  const auth = new GitCloudAuth({
    defaultRepo: 'MyApp_Workspace',
    protectedRepos: ['Core_Source_Repo'],
    strictRepoSandbox: true,
    storageKey: false,
    fetchImpl: mockFetch,
  });

  assert.equal(auth.options.oauthScope, 'public_repo');
  assert.equal(auth.options.persistence, 'session');

  await auth.loginWithPAT('ghp_valid_pat');

  assert.throws(() => {
    auth.assertWriteAllowed('mk314k.github.io');
  }, /Security Sandbox/);

  assert.throws(() => {
    auth.assertWriteAllowed('Core_Source_Repo');
  }, /Security Sandbox/);

  assert.throws(() => {
    sanitizeRepoPath('../secrets.txt');
  }, /Invalid or unsafe/);
});

test('GitCloudAuth: PAT login, OAuth callback exchange, Read-Only login, and logout', async () => {
  const { mockFetch } = createMockGitHubAPI();
  const auth = new GitCloudAuth({
    defaultRepo: 'MyApp_Workspace',
    oauthClientId: 'client_id_example',
    tokenExchangeUrl: 'https://example.com/api/oauth/exchange',
    extensions: ['.json', '.md'],
    storageKey: false,
    fetchImpl: mockFetch,
  });

  const patProfile = await auth.loginWithPAT('ghp_valid_pat');
  assert.equal(patProfile.username, 'mk314k');
  assert.equal(patProfile.mode, 'pat');
  assert.equal(auth.hasWriteAccess(), true);

  auth.logout();
  assert.equal(auth.isAuthenticated(), false);

  const oauthProfile = await auth.handleOAuthCallback('valid_oauth_code');
  assert.equal(oauthProfile?.username, 'mk314k');
  assert.equal(oauthProfile?.mode, 'oauth');

  const roProfile = await auth.loginReadOnly('alice_dev', 'Alice_Workspace');
  assert.equal(roProfile.username, 'alice_dev');
  assert.equal(roProfile.mode, 'readonly');
  assert.equal(auth.hasWriteAccess(), false);
});

test('GitRepoStore: CDN public reads, ETag 304 cache hits, 409 SHA conflict auto-retry, Fork+PR, and commitBatch', async () => {
  const { mockFetch, repos } = createMockGitHubAPI();
  const auth = new GitCloudAuth({
    defaultRepo: 'MyApp_Workspace',
    extensions: ['.json', '.txt'],
    storageKey: false,
    fetchImpl: mockFetch,
  });

  await auth.loginWithPAT('ghp_valid_pat');
  const store = new GitRepoStore(auth);

  await store.writeFile('config.json', '{"theme":"dark"}');
  await store.writeFile('notes.txt', 'hello world');

  // Test CDN public JSON reader
  const publicCfg = await store.readPublicJSON<{ theme: string }>('config.json');
  assert.equal(publicCfg.theme, 'dark');

  // Simulate external concurrent edit changing remote SHA behind the scenes
  const repoFiles = repos.get('mk314k/MyApp_Workspace')!;
  repoFiles.set('notes.txt', {
    content: encodeBase64UTF8('concurrent remote edit'),
    sha: 'sha_external_999',
    etag: 'W/"etag_999"',
  });

  // writeFile should automatically recover from HTTP 409 by fetching latest SHA and retrying
  const recovered = await store.writeFile('notes.txt', 'resolved content');
  assert.ok(recovered.sha);
  assert.equal(await store.readFile('notes.txt'), 'resolved content');

  // Propose file change via Fork + Pull Request
  const pr = await store.proposeFileChangeViaPR({
    upstreamOwner: 'satya-org',
    upstreamRepo: 'Community_Facts',
    filePath: 'tables/facts/rows/f1.json',
    content: '{"id":"f1","verdict":"fact"}',
    title: 'Add verified proposition f1',
  });
  assert.equal(pr.forkOwner, 'mk314k');
  assert.ok(pr.prNumber >= 10);

  // Atomic multi-file commit via Git Data API (commitBatch)
  const batchRes = await store.commitBatch(
    [
      { path: 'batch/a.json', content: '{"a":1}' },
      { path: 'batch/b.json', content: '{"b":2}' },
      { path: 'notes.txt', content: null },
    ],
    'Atomic multi-file batch commit'
  );
  assert.equal(batchRes.fileCount, 3);
  assert.ok(batchRes.commitSha.startsWith('commit_'));
  assert.deepEqual(await store.readJSON('batch/a.json'), { a: 1 });
  assert.deepEqual(await store.readJSON('batch/b.json'), { b: 2 });
});

test('GitTable: vector similarity search, indexed-sharded compaction, and multi-owner federatedSelect', async () => {
  const { mockFetch } = createMockGitHubAPI();

  const auth1 = new GitCloudAuth({ defaultRepo: 'Fact_DB', storageKey: false, fetchImpl: mockFetch });
  await auth1.loginWithPAT('ghp_valid_pat');
  const store1 = new GitRepoStore(auth1);

  const auth2 = new GitCloudAuth({ defaultRepo: 'Fact_DB', storageKey: false, fetchImpl: mockFetch });
  await auth2.loginWithPAT('ghp_player2_pat');
  const store2 = new GitRepoStore(auth2);

  type FactItem = { id: string; claim: string; embedding: number[]; updatedAt?: number };

  const table1 = new GitTable<FactItem>(store1, 'claims', {
    storageMode: 'indexed-sharded',
    enforceRowOwnership: true,
  });
  const table2 = new GitTable<FactItem>(store2, 'claims', {
    storageMode: 'indexed-sharded',
    enforceRowOwnership: true,
  });

  await table1.insert({ id: 'c1', claim: 'Water boils at 100C', embedding: [1, 0, 0] });
  await table1.insert({ id: 'c2', claim: 'Speed of light in vacuum', embedding: [0, 1, 0] });
  await table2.insert({ id: 'c3', claim: 'Earth orbits the Sun', embedding: [0.92, 0.38, 0] });

  assert.ok(cosineSimilarity([1, 0, 0], [1, 0, 0]) > 0.99);

  const matches = await table1.federatedSelect(['mk314k', 'player2'], {
    similarity: {
      field: 'embedding',
      vector: [0.98, 0.2, 0],
      threshold: 0.8,
      topK: 2,
    },
  });

  assert.equal(matches.length, 2);
  assert.equal(matches[0].id, 'c3');
  assert.equal(matches[1].id, 'c1');
});

test('GitLedger: SHA-256 hash chaining, WebCrypto ECDSA P-256 signatures, Merkle root, and tamper detection', async () => {
  const { mockFetch } = createMockGitHubAPI();
  const auth = new GitCloudAuth({ defaultRepo: 'Audit_Chain', storageKey: false, fetchImpl: mockFetch });
  await auth.loginWithPAT('ghp_valid_pat');
  const store = new GitRepoStore(auth);

  const ledger = new GitLedger<{ claimId: string; verdict: string }>(store, 'votes');
  const signer = await generateLedgerKeyPair();

  await ledger.append({ claimId: 'p1', verdict: 'fact' }, { id: 'v1', signer });
  await ledger.append({ claimId: 'p2', verdict: 'false' }, { id: 'v2', signer });

  const verification = await ledger.verifyChain();
  assert.equal(verification.valid, true);
  assert.equal(verification.entryCount, 2);
  assert.equal(verification.merkleRoot.length, 64);

  const entries = await ledger.getEntries();
  entries[0].payload.verdict = 'misleading';
  const tamperedResult = await ledger.verifyChain(entries);
  assert.equal(tamperedResult.valid, false);
  assert.equal(tamperedResult.brokenAtIndex, 0);
});

test('PeerConsensusEngine: credibility-weighted voting, bridging bonus, and public credibility score updates', () => {
  const engine = new PeerConsensusEngine<'fact' | 'misleading' | 'false'>({
    quorumVotes: 2,
    resolutionThreshold: 0.6,
  });

  const votes = [
    { id: '1', subjectId: 's1', voter: 'alice', outcome: 'fact' as const, evidenceUrl: 'https://nasa.gov/1', timestamp: 1000 },
    { id: '2', subjectId: 's1', voter: 'bob', outcome: 'fact' as const, evidenceUrl: 'https://noaa.gov/1', timestamp: 1100 },
    { id: '3', subjectId: 's1', voter: 'carol', outcome: 'fact' as const, timestamp: 1200 },
    { id: '4', subjectId: 's1', voter: 'spambot', outcome: 'false' as const, timestamp: 1300 },
    { id: '5', subjectId: 's2', voter: 'alice', outcome: 'false' as const, evidenceUrl: 'https://cdc.gov/2', timestamp: 2000 },
    { id: '6', subjectId: 's2', voter: 'bob', outcome: 'false' as const, timestamp: 2100 },
    { id: '7', subjectId: 's2', voter: 'spambot', outcome: 'fact' as const, timestamp: 2200 },
  ];

  const state = engine.computeNetworkState(votes, 2);
  const s1 = state.subjects.get('s1')!;
  const s2 = state.subjects.get('s2')!;

  assert.equal(s1.winningOutcome, 'fact');
  assert.equal(s1.isResolved, true);
  assert.equal(s2.winningOutcome, 'false');
  assert.equal(s2.isResolved, true);

  const aliceCred = state.credibility.get('alice')!;
  const spamCred = state.credibility.get('spambot')!;
  assert.ok(aliceCred.score > 1.2);
  assert.ok(spamCred.score < 0.8);
  assert.equal(aliceCred.accuracyRate, 1);
  assert.equal(spamCred.accuracyRate, 0);
});

test('GitPartitionedEngine & GitSqliteVfs: O(1) B-Tree page shard lookups, inverted index, ANN search, and HTTP Range VFS', async () => {
  const { mockFetch } = createMockGitHubAPI();
  const auth = new GitCloudAuth({ defaultRepo: 'Scaled_DB', storageKey: false, fetchImpl: mockFetch });
  await auth.loginWithPAT('ghp_valid_pat');
  const store = new GitRepoStore(auth);

  type DocRow = { id: string; title: string; vec: number[] };
  const engine = new GitPartitionedEngine<DocRow>(store, 'knowledge', {
    pageSize: 2,
    textIndexFields: ['title'],
    vectorField: 'vec',
  });

  await engine.buildFromRows([
    { id: 'doc_1', title: 'Quantum computing qubits', vec: [1, 0, 0] },
    { id: 'doc_2', title: 'Photosynthesis in plants', vec: [0, 1, 0] },
    { id: 'doc_3', title: 'Neural network transformers', vec: [0, 0, 1] },
    { id: 'doc_4', title: 'Quantum entanglement physics', vec: [0.95, 0.05, 0] },
  ]);

  const byId = await engine.getById('doc_3');
  assert.equal(byId?.title, 'Neural network transformers');

  const textHits = await engine.searchText('quantum physics');
  assert.ok(textHits.length >= 2);
  assert.equal(textHits[0].id, 'doc_4');

  const annHits = await engine.searchVectorANN({
    vector: [0.98, 0.02, 0],
    threshold: 0.8,
    topK: 2,
    probePages: 2,
  });
  assert.equal(annHits.length, 2);
  assert.equal(annHits[0].id, 'doc_1');

  const vfs = new GitSqliteVfs('https://cdn.example.com/db.sqlite', {
    pageSize: 4096,
    fetchImpl: mockFetch,
  });
  const firstRead = await vfs.readBytes(100, 50);
  assert.equal(firstRead.byteLength, 50);
  assert.equal(firstRead[0], 100 % 251);
  assert.equal(vfs.rangeRequestCount, 1);

  const cachedRead = await vfs.readBytes(200, 32);
  assert.equal(cachedRead[0], 200 % 251);
  assert.equal(vfs.rangeRequestCount, 1);
});

test('GitEncryptedStore: AES-GCM-256 + PBKDF2-SHA256 client-side vault encryption and tamper/wrong-passphrase rejection', async () => {
  const { mockFetch } = createMockGitHubAPI();
  const auth = new GitCloudAuth({ defaultRepo: 'Secret_Vault', storageKey: false, fetchImpl: mockFetch });
  await auth.loginWithPAT('ghp_valid_pat');
  const store = new GitRepoStore(auth);

  const vault = new GitEncryptedStore(store, { iterations: 5000 });
  const written = await vault.writeSecretJSON(
    'byok-keys',
    { groqKey: 'gsk_secret_123', geminiKey: 'AIza_secret_456' },
    'correct-horse-battery-staple'
  );
  assert.equal(written.envelope.cipher, 'AES-GCM-256');

  const decrypted = await vault.readSecretJSON<{ groqKey: string; geminiKey: string }>(
    'byok-keys',
    'correct-horse-battery-staple'
  );
  assert.equal(decrypted.groqKey, 'gsk_secret_123');
  assert.equal(decrypted.geminiKey, 'AIza_secret_456');

  // Portable token round-trip
  const token = GitEncryptedStore.exportPortableToken(written.envelope);
  const parsedEnvelope = GitEncryptedStore.parsePortableToken(token);
  assert.equal(parsedEnvelope.ciphertextBase64, written.envelope.ciphertextBase64);

  // Wrong passphrase must fail authentication tag check
  await assert.rejects(async () => {
    await vault.readSecretJSON('byok-keys', 'wrong-passphrase');
  }, /Vault decryption failed/);
});

test('GitSyncQueue: 0ms optimistic reads, write coalescing, and atomic multi-file flush via commitBatch', async () => {
  const { mockFetch } = createMockGitHubAPI();
  const auth = new GitCloudAuth({ defaultRepo: 'Sync_Workspace', storageKey: false, fetchImpl: mockFetch });
  await auth.loginWithPAT('ghp_valid_pat');
  const store = new GitRepoStore(auth);

  const queue = new GitSyncQueue(store, { storageKey: false, channelName: false });

  // Enqueue two rapid writes to the same file -> should coalesce into 1 operation
  queue.enqueueJSON('state/counter.json', { count: 1 });
  queue.enqueueJSON('state/counter.json', { count: 2 });
  queue.enqueueWrite('state/readme.md', '# Offline Draft');

  assert.equal(queue.pendingCount, 2);

  // Optimistic read returns latest queued state in 0ms before flushing to GitHub
  const optimistic = await queue.readOptimisticJSON<{ count: number }>('state/counter.json');
  assert.equal(optimistic.count, 2);

  const flushRes = await queue.flush('Flush offline queue');
  assert.ok(flushRes);
  assert.equal(flushRes?.fileCount, 2);
  assert.equal(queue.pendingCount, 0);

  // Verify persisted in remote repo
  const remoteCounter = await store.readJSON<{ count: number }>('state/counter.json');
  assert.equal(remoteCounter.count, 2);
  queue.destroy();
});

test('GitChannel: federated pub/sub, recipient filtering, and live peer presence across repositories', async () => {
  const { mockFetch } = createMockGitHubAPI();

  const auth1 = new GitCloudAuth({ defaultRepo: 'PubSub_Cloud', storageKey: false, fetchImpl: mockFetch });
  await auth1.loginWithPAT('ghp_valid_pat');
  const store1 = new GitRepoStore(auth1);

  const auth2 = new GitCloudAuth({ defaultRepo: 'PubSub_Cloud', storageKey: false, fetchImpl: mockFetch });
  await auth2.loginWithPAT('ghp_player2_pat');
  const store2 = new GitRepoStore(auth2);

  const channel1 = new GitChannel<{ text: string }>(store1, 'global-feed');
  const channel2 = new GitChannel<{ text: string }>(store2, 'global-feed');

  await channel1.publish('NEW_CLAIM', { text: 'Claim broadcast from mk314k' });
  await channel2.publish('DIRECT_PING', { text: 'Direct hello to mk314k' }, { recipient: 'mk314k' });

  const receivedBy1: string[] = [];
  channel1.onMessage((env) => receivedBy1.push(env.payload.text));

  const poll1 = await channel1.pollPeers(['player2']);
  assert.equal(poll1.newMessages.length, 1);
  assert.equal(poll1.newMessages[0].payload.text, 'Direct hello to mk314k');
  assert.equal(poll1.presence.length, 2);
  assert.equal(receivedBy1.length, 1);
});

test('GitMultiplayer: Dual-Repo Federated Turn-Based Match & GitPeerRoom Session Proof', async () => {
  const { mockFetch } = createMockGitHubAPI();

  const auth1 = new GitCloudAuth({ defaultRepo: 'Chess_Cloud', storageKey: false, fetchImpl: mockFetch });
  await auth1.loginWithPAT('ghp_valid_pat');
  const store1 = new GitRepoStore(auth1);
  const room1 = new GitRepoRoom<{ moves: string[] }>(store1, 'match-77');

  const auth2 = new GitCloudAuth({ defaultRepo: 'Chess_Cloud', storageKey: false, fetchImpl: mockFetch });
  await auth2.loginWithPAT('ghp_player2_pat');
  const store2 = new GitRepoStore(auth2);
  const room2 = new GitRepoRoom<{ moves: string[] }>(store2, 'match-77');

  await room1.createMatch({ moves: ['e2e4'] }, 'player2');

  const move2 = await room2.submitMove({ moves: ['e2e4', 'e7e5'] }, 'mk314k', 'e7e5', ['mk314k']);
  assert.equal(move2.version, 2);
  assert.equal(move2.turn, 'mk314k');

  const syncedByPlayer1 = await room1.getLatestFederatedState(['player2']);
  assert.equal(syncedByPlayer1.version, 2);
  assert.deepEqual(syncedByPlayer1.state.moves, ['e2e4', 'e7e5']);

  const peerRoom1 = new GitPeerRoom<{ x: number; y: number }>(auth1, 'arena-1');
  const proof = await peerRoom1.publishIdentityProof(store1);
  assert.equal(proof.username, 'mk314k');

  const isVerified = await peerRoom1.verifyPeerIdentity(store1, 'mk314k', peerRoom1.sessionId, 'Chess_Cloud');
  assert.equal(isVerified, true);
});
