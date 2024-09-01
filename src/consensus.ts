/**
 * Peer consensus and reputation scoring engine (`PeerConsensusEngine`).
 *
 * Computes weighted vote outcomes, cross-voter agreement bridging adjustments,
 * and iterative voter credibility scores from an append-only vote log.
 */

export interface PeerVote<Outcome extends string = string> {
  /** Vote identifier */
  id: string;
  /** Target subject or proposition identifier */
  subjectId: string;
  /** Voter username or identifier */
  voter: string;
  /** Selected outcome label */
  outcome: Outcome;
  /** Optional primary-source citation URL */
  evidenceUrl?: string;
  /** Optional written rationale */
  reasoning?: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
}

export interface PeerCredibilityRecord {
  username: string;
  score: number;
  totalVotes: number;
  alignedVotes: number;
  evidenceCount: number;
  accuracyRate: number;
  updatedAt: number;
}

export interface SubjectConsensusResult<Outcome extends string = string> {
  subjectId: string;
  winningOutcome: Outcome | 'unverified';
  confidence: number;
  totalVotes: number;
  totalWeight: number;
  bridgingBonus: number;
  outcomeWeights: Record<string, number>;
  topEvidenceUrls: string[];
  isResolved: boolean;
}

export interface ConsensusEngineOptions {
  /** Initial credibility score assigned to new voters (default: 1.0) */
  defaultCredibility?: number;
  /** Minimum credibility bound (default: 0.1) */
  minCredibility?: number;
  /** Maximum credibility bound (default: 5.0) */
  maxCredibility?: number;
  /** Minimum distinct voters required for subject resolution (default: 2) */
  quorumVotes?: number;
  /** Minimum confidence in [0, 1] required for resolution (default: 0.6) */
  resolutionThreshold?: number;
  /** Weight multiplier applied when `evidenceUrl` is present (default: 1.2) */
  evidenceWeightMultiplier?: number;
  /** Credibility increment on alignment with a resolved outcome (default: 0.15) */
  alignedReward?: number;
  /** Credibility decrement when contradicting a resolved outcome (default: 0.2) */
  misalignedPenalty?: number;
}

export class PeerConsensusEngine<Outcome extends string = string> {
  public readonly options: Required<ConsensusEngineOptions>;

  constructor(options: ConsensusEngineOptions = {}) {
    this.options = {
      defaultCredibility: options.defaultCredibility ?? 1.0,
      minCredibility: options.minCredibility ?? 0.1,
      maxCredibility: options.maxCredibility ?? 5.0,
      quorumVotes: options.quorumVotes ?? 2,
      resolutionThreshold: options.resolutionThreshold ?? 0.6,
      evidenceWeightMultiplier: options.evidenceWeightMultiplier ?? 1.2,
      alignedReward: options.alignedReward ?? 0.15,
      misalignedPenalty: options.misalignedPenalty ?? 0.2,
    };
  }

  /**
   * Deduplicate votes so each voter counts once per `subjectId` (latest `timestamp` wins).
   */
  public deduplicateSubjectVotes(votes: readonly PeerVote<Outcome>[]): PeerVote<Outcome>[] {
    const byVoter = new Map<string, PeerVote<Outcome>>();
    for (const v of votes) {
      const key = v.voter.toLowerCase();
      const prev = byVoter.get(key);
      if (!prev || v.timestamp >= prev.timestamp) {
        byVoter.set(key, v);
      }
    }
    return Array.from(byVoter.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Compute the weighted outcome and confidence for `subjectId`.
   */
  public evaluateSubject(
    subjectId: string,
    votes: readonly PeerVote<Outcome>[],
    credibilityMap: ReadonlyMap<string, number> | Record<string, number> = new Map(),
    voterPairAgreement: ReadonlyMap<string, number> = new Map()
  ): SubjectConsensusResult<Outcome> {
    const subjectVotes = this.deduplicateSubjectVotes(
      votes.filter((v) => v.subjectId === subjectId)
    );

    if (subjectVotes.length === 0) {
      return {
        subjectId,
        winningOutcome: 'unverified',
        confidence: 0,
        totalVotes: 0,
        totalWeight: 0,
        bridgingBonus: 0,
        outcomeWeights: {},
        topEvidenceUrls: [],
        isResolved: false,
      };
    }

    const getCred = (voter: string): number => {
      const key = voter.toLowerCase();
      if (credibilityMap instanceof Map) {
        return credibilityMap.get(key) ?? credibilityMap.get(voter) ?? this.options.defaultCredibility;
      }
      const record = credibilityMap as Record<string, number>;
      return record[key] ?? record[voter] ?? this.options.defaultCredibility;
    };

    const outcomeWeights: Record<string, number> = {};
    const evidenceByOutcome = new Map<string, Set<string>>();
    let totalWeight = 0;

    for (const vote of subjectVotes) {
      const baseCred = Math.max(
        this.options.minCredibility,
        Math.min(this.options.maxCredibility, getCred(vote.voter))
      );
      const hasEvidence = Boolean(vote.evidenceUrl && /^https?:\/\//i.test(vote.evidenceUrl.trim()));
      const weight = baseCred * (hasEvidence ? this.options.evidenceWeightMultiplier : 1.0);

      outcomeWeights[vote.outcome] = (outcomeWeights[vote.outcome] ?? 0) + weight;
      totalWeight += weight;

      if (hasEvidence && vote.evidenceUrl) {
        if (!evidenceByOutcome.has(vote.outcome)) {
          evidenceByOutcome.set(vote.outcome, new Set());
        }
        evidenceByOutcome.get(vote.outcome)!.add(vote.evidenceUrl.trim());
      }
    }

    let winningOutcome: Outcome | 'unverified' = 'unverified';
    let bestWeight = -1;
    for (const [outcome, weight] of Object.entries(outcomeWeights)) {
      if (weight > bestWeight) {
        bestWeight = weight;
        winningOutcome = outcome as Outcome;
      }
    }

    const winningVoters = subjectVotes
      .filter((v) => v.outcome === winningOutcome)
      .map((v) => v.voter.toLowerCase());

    let bridgingBonus = 0;
    if (winningVoters.length >= 2 && voterPairAgreement.size > 0) {
      let pairSum = 0;
      let pairCount = 0;
      for (let i = 0; i < winningVoters.length; i++) {
        for (let j = i + 1; j < winningVoters.length; j++) {
          const [a, b] = [winningVoters[i], winningVoters[j]].sort();
          const historicalAgreement = voterPairAgreement.get(`${a}|${b}`);
          if (historicalAgreement !== undefined) {
            pairSum += 1 - historicalAgreement;
            pairCount += 1;
          }
        }
      }
      if (pairCount > 0) {
        bridgingBonus = Math.min(0.15, (pairSum / pairCount) * 0.2);
      }
    }

    const rawShare = totalWeight > 0 ? bestWeight / totalWeight : 0;
    const quorumFactor = Math.min(1, subjectVotes.length / Math.max(1, this.options.quorumVotes));
    const confidence = Number(Math.min(1, rawShare * quorumFactor + bridgingBonus).toFixed(4));

    const isResolved =
      subjectVotes.length >= this.options.quorumVotes &&
      confidence >= this.options.resolutionThreshold &&
      winningOutcome !== 'unverified';

    const topEvidenceUrls = Array.from(evidenceByOutcome.get(winningOutcome) ?? []);

    return {
      subjectId,
      winningOutcome: isResolved ? winningOutcome : 'unverified',
      confidence,
      totalVotes: subjectVotes.length,
      totalWeight: Number(totalWeight.toFixed(4)),
      bridgingBonus: Number(bridgingBonus.toFixed(4)),
      outcomeWeights,
      topEvidenceUrls,
      isResolved,
    };
  }

  /**
   * Compute pairwise agreement rates in [0, 1] across all co-voted subjects.
   */
  public computePairwiseAgreement(allVotes: readonly PeerVote<Outcome>[]): Map<string, number> {
    const bySubject = new Map<string, PeerVote<Outcome>[]>();
    for (const v of allVotes) {
      if (!bySubject.has(v.subjectId)) {
        bySubject.set(v.subjectId, []);
      }
      bySubject.get(v.subjectId)!.push(v);
    }

    const pairTotals = new Map<string, { same: number; total: number }>();
    for (const subjectVotes of bySubject.values()) {
      const deduped = this.deduplicateSubjectVotes(subjectVotes);
      for (let i = 0; i < deduped.length; i++) {
        for (let j = i + 1; j < deduped.length; j++) {
          const [a, b] = [deduped[i].voter.toLowerCase(), deduped[j].voter.toLowerCase()].sort();
          const key = `${a}|${b}`;
          const rec = pairTotals.get(key) ?? { same: 0, total: 0 };
          rec.total += 1;
          if (deduped[i].outcome === deduped[j].outcome) {
            rec.same += 1;
          }
          pairTotals.set(key, rec);
        }
      }
    }

    const agreement = new Map<string, number>();
    for (const [key, stats] of pairTotals.entries()) {
      agreement.set(key, stats.total > 0 ? stats.same / stats.total : 0.5);
    }
    return agreement;
  }

  /**
   * Recompute subject outcomes and voter credibility records over `rounds` iterations.
   */
  public computeNetworkState(
    allVotes: readonly PeerVote<Outcome>[],
    rounds = 2
  ): {
    subjects: Map<string, SubjectConsensusResult<Outcome>>;
    credibility: Map<string, PeerCredibilityRecord>;
  } {
    const subjectIds = Array.from(new Set(allVotes.map((v) => v.subjectId)));
    const voters = Array.from(new Set(allVotes.map((v) => v.voter.toLowerCase())));
    const pairwiseAgreement = this.computePairwiseAgreement(allVotes);

    const scoreMap = new Map<string, number>();
    for (const voter of voters) {
      scoreMap.set(voter, this.options.defaultCredibility);
    }

    let subjects = new Map<string, SubjectConsensusResult<Outcome>>();
    const statsByVoter = new Map<
      string,
      { totalVotes: number; alignedVotes: number; evidenceCount: number }
    >();

    for (let round = 0; round < Math.max(1, rounds); round++) {
      subjects = new Map();
      for (const sid of subjectIds) {
        subjects.set(
          sid,
          this.evaluateSubject(sid, allVotes, scoreMap, pairwiseAgreement)
        );
      }

      const nextScores = new Map<string, number>();
      statsByVoter.clear();

      for (const voter of voters) {
        nextScores.set(voter, this.options.defaultCredibility);
        statsByVoter.set(voter, { totalVotes: 0, alignedVotes: 0, evidenceCount: 0 });
      }

      for (const sid of subjectIds) {
        const subjectVotes = this.deduplicateSubjectVotes(
          allVotes.filter((v) => v.subjectId === sid)
        );
        const consensus = subjects.get(sid)!;

        subjectVotes.forEach((vote, orderIndex) => {
          const voterKey = vote.voter.toLowerCase();
          const st = statsByVoter.get(voterKey)!;
          st.totalVotes += 1;
          const hasEvidence = Boolean(vote.evidenceUrl && /^https?:\/\//i.test(vote.evidenceUrl.trim()));
          if (hasEvidence) {
            st.evidenceCount += 1;
          }

          if (!consensus.isResolved) return;

          const currentScore = nextScores.get(voterKey) ?? this.options.defaultCredibility;
          if (vote.outcome === consensus.winningOutcome) {
            st.alignedVotes += 1;
            const earlyMultiplier = orderIndex < 2 ? 1.25 : 1.0;
            const evidenceBonus = hasEvidence ? 0.04 : 0;
            const delta = this.options.alignedReward * consensus.confidence * earlyMultiplier + evidenceBonus;
            nextScores.set(
              voterKey,
              Math.min(this.options.maxCredibility, currentScore + delta)
            );
          } else {
            const penalty = this.options.misalignedPenalty * consensus.confidence;
            nextScores.set(
              voterKey,
              Math.max(this.options.minCredibility, currentScore - penalty)
            );
          }
        });
      }

      for (const [k, v] of nextScores.entries()) {
        scoreMap.set(k, Number(v.toFixed(4)));
      }
    }

    const now = Date.now();
    const credibility = new Map<string, PeerCredibilityRecord>();
    for (const voter of voters) {
      const st = statsByVoter.get(voter) ?? { totalVotes: 0, alignedVotes: 0, evidenceCount: 0 };
      const accuracyRate = st.totalVotes > 0 ? Number((st.alignedVotes / st.totalVotes).toFixed(4)) : 0;
      credibility.set(voter, {
        username: voter,
        score: scoreMap.get(voter) ?? this.options.defaultCredibility,
        totalVotes: st.totalVotes,
        alignedVotes: st.alignedVotes,
        evidenceCount: st.evidenceCount,
        accuracyRate,
        updatedAt: now,
      });
    }

    return { subjects, credibility };
  }
}
