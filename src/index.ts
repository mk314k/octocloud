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
  type PublicReadStrategy,
  type ReadPublicFileOptions,
  type PullRequestProposalResult,
  type BatchFileChange,
  type BatchCommitResult,
} from './store';

export {
  GitTable,
  cosineSimilarity,
  type TableRow,
  type VectorSimilarityClause,
  type SelectQuery,
  type GitTableOptions,
} from './table';

export {
  GitLedger,
  GENESIS_PREV_HASH,
  sha256Hex,
  generateLedgerKeyPair,
  signLedgerHash,
  verifyLedgerSignature,
  computeMerkleRoot,
  type LedgerEntry,
  type LedgerVerificationResult,
  type LedgerKeyPair,
} from './ledger';

export {
  PeerConsensusEngine,
  type PeerVote,
  type PeerCredibilityRecord,
  type SubjectConsensusResult,
  type ConsensusEngineOptions,
} from './consensus';

export {
  GitPartitionedEngine,
  GitSqliteVfs,
  tokenizeForIndex,
  type PartitionPageMeta,
  type PartitionManifest,
  type PartitionEngineOptions,
} from './sqlite';

export {
  GitEncryptedStore,
  encryptPayloadWithPassphrase,
  decryptEnvelopeWithPassphrase,
  type EncryptedEnvelope,
  type EncryptedVaultOptions,
} from './vault';

export {
  GitSyncQueue,
  type QueuedOperation,
  type SyncQueueOptions,
  type SyncQueueListener,
} from './sync';

export {
  GitChannel,
  type ChannelEnvelope,
  type PeerPresenceState,
  type ChannelInboxState,
  type ChannelMessageListener,
  type PresenceListener,
  type GitChannelOptions,
} from './channel';

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
