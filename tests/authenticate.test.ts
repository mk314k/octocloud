import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GitCloudAuth,
  GitRepoStore,
  GitTable,
  GitPeerRoom,
  GitRepoRoom,
  sanitizeRepoPath,
  encodeBase64UTF8,
  decodeBase64UTF8,
} from '../src/index.ts';

function createMockGitHubAPI() {
  const repos = new Map<string, Map<string, { content: string; sha: string }>>();
  let shaCounter = 100;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method || 'GET').toUpperCase();
    const headers = (init?.headers || {}) as Record<string, string>;
    const authHeader = headers['Authorization'] || '';

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
          // Check if filePath is a directory prefix
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
        return new Response(
          JSON.stringify({
            name: filePath.split('/').pop() || filePath,
            path: filePath,
            sha: fileEntry.sha,
            content: fileEntry.content,
          }),
          { status: 200 }
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
          return new Response(JSON.stringify({ message: 'Missing or mismatched sha' }), { status: 422 });
        }
        const newSha = `sha_${++shaCounter}`;
        targetRepo.set(filePath, { content: body.content, sha: newSha });
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

test('GitRepoStore: auto-creates repo, filters by extension, tracks SHAs on update, and deletes files', async () => {
  const { mockFetch } = createMockGitHubAPI();
  const auth = new GitCloudAuth({
    defaultRepo: 'MyApp_Workspace',
    extensions: ['.json', '.txt'],
    storageKey: false,
    fetchImpl: mockFetch,
  });

  await auth.loginWithPAT('ghp_valid_pat');
  const store = new GitRepoStore(auth);

  const initialFiles = await store.listFiles();
  assert.equal(initialFiles.length, 0);

  await store.writeFile('config.json', '{"theme":"dark"}');
  await store.writeFile('notes.txt', 'hello world');
  await store.writeFile('ignored.bin', 'binary');

  const filtered = await store.listFiles();
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((f) => f.name).sort(), ['config.json', 'notes.txt']);

  const updated = await store.writeFile('notes.txt', 'updated text');
  assert.ok(updated.sha);
  const content = await store.readFile('notes.txt');
  assert.equal(content, 'updated text');

  await store.deleteFile('config.json');
  const afterDelete = await store.listFiles();
  assert.equal(afterDelete.length, 1);
});

test('GitTable: insert, select query builder, row-level ownership, sharded mode, and innerJoin', async () => {
  const { mockFetch } = createMockGitHubAPI();
  const auth = new GitCloudAuth({
    defaultRepo: 'App_Database',
    storageKey: false,
    fetchImpl: mockFetch,
  });
  await auth.loginWithPAT('ghp_valid_pat');
  const store = new GitRepoStore(auth);

  const usersTable = new GitTable<{ id: string; role: string }>(store, 'users');
  const scoresTable = new GitTable<{ id: string; userId: string; score: number }>(store, 'scores', {
    storageMode: 'sharded',
    enforceRowOwnership: true,
  });

  await usersTable.insert({ id: 'u1', role: 'admin' });
  await usersTable.insert({ id: 'u2', role: 'player' });

  await scoresTable.insert({ id: 's1', userId: 'u1', score: 420 });
  await scoresTable.insert({ id: 's2', userId: 'u2', score: 890 });

  const highScorers = await scoresTable.select({
    where: (r) => r.score >= 500,
    orderBy: 'score',
    desc: true,
  });
  assert.equal(highScorers.length, 1);
  assert.equal(highScorers[0].id, 's2');

  const joined = await usersTable.innerJoin(
    scoresTable,
    'id',
    'userId',
    (u, s) => ({ userId: u.id, role: u.role, score: s.score })
  );
  assert.equal(joined.length, 2);
});

test('GitMultiplayer: Dual-Repo Federated Turn-Based Match (no shared tokens between Player 1 and Player 2)', async () => {
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
});

test('GitMultiplayer: GitPeerRoom Anti-Spoofing Session Proof & Sequenced Packets', async () => {
  const { mockFetch } = createMockGitHubAPI();
  const auth1 = new GitCloudAuth({ defaultRepo: 'Game_Cloud', storageKey: false, fetchImpl: mockFetch });
  await auth1.loginWithPAT('ghp_valid_pat');
  const store1 = new GitRepoStore(auth1);

  const peerRoom1 = new GitPeerRoom<{ x: number; y: number }>(auth1, 'arena-1');
  const proof = await peerRoom1.publishIdentityProof(store1);
  assert.equal(proof.username, 'mk314k');

  const isVerified = await peerRoom1.verifyPeerIdentity(store1, 'mk314k', peerRoom1.sessionId, 'Game_Cloud');
  assert.equal(isVerified, true);

  const isSpoofValid = await peerRoom1.verifyPeerIdentity(store1, 'mk314k', 'sess_fake_spoof', 'Game_Cloud');
  assert.equal(isSpoofValid, false);

  const msg1 = peerRoom1.send('PLAYER_POS', { x: 10, y: 20 });
  const msg2 = peerRoom1.send('PLAYER_POS', { x: 15, y: 25 });
  assert.equal(msg1.seq, 1);
  assert.equal(msg2.seq, 2);
});
