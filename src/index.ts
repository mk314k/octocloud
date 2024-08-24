export {
  GitCloudAuth,
  type AuthMode,
  type StoragePersistence,
  type GitUserProfile,
  type GitAuthOptions,
  type AuthStateListener,
} from './auth';

export {
  GitRepoStore,
  sanitizeRepoPath,
  type RepoFileEntry,
  type LoadedRepoFile,
} from './store';

export {
  GitTable,
  type TableRow,
  type SelectQuery,
  type GitTableOptions,
} from './table';

export {
  GitPeerRoom,
  GitRepoRoom,
  type PlayerIdentity,
  type SessionProof,
  type MultiplayerMessage,
  type PeerSignalTicket,
  type SharedMatchState,
  type MessageListener,
  type PeerConnectionListener,
} from './multiplayer';

export {
  GitAuthModal,
  type GitAuthModalOptions,
} from './modal';

export {
  encodeBase64UTF8,
  decodeBase64UTF8,
} from './base64';
