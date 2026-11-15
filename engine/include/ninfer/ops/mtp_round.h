#pragma once

#include "core/tensor.h"

#include <cuda_runtime.h>

namespace ninfer::ops {

/**
 * Op: mtp_prepare_next_round
 *
 * Math / indexing:
 *   For T=K+1 and each row b with A=accepted[b], L=licensed_counts[b]:
 *     alignment_ids[j,b] = verify_ids[j+1,b]  for 0<=j<A
 *                          next_anchors[b]     otherwise;
 *     remaining_after = max(remaining_budgets[b]-L,0);
 *     logical_after   = logical_frontiers[b];
 *     context_after   = max(max_context-logical_after-1,0);
 *     next_extents[b] = min(P,max(remaining_after-1,0),context_after);
 *     For S=max(P-1,1) and 0<=s<S:
 *       ar_positions[b,s]      = updated_frontiers[b]+L+s;
 *       ar_rope_positions[b,s] = logical_after+s+rope_deltas[b];
 *       ar_valid_columns[b,s]  = (s+1 < next_extents[b]).
 *   `updated_frontiers` carries the CACHE BASE (compact when KVMem compaction is on);
 *   `logical_frontiers` carries logical AFTER: acceptance used the absolute logical
 *   base for RNG and advanced it by L. The cache base is independently advanced by L.
 *   Without compaction, updated_frontiers + L = logical_frontiers.
 *   K is the round's verification width and P = proposal_drafts the drafts the next round
 *   proposes. The two are independent: an adaptive round verifies fewer drafts than the window
 *   it proposes, and an ngram copy round verifies more.
 *
 * Logical shapes / effects:
 *   verify_ids/alignment_ids are distinct contiguous I32 [K+1,B]. ar_positions,
 *   ar_rope_positions, and ar_valid_columns are I32 [B,max(P-1,1)] with contiguous rows and one
 *   shared step stride at least B; this permits an exact-B prefix of a fixed-capacity frame. All
 *   other tensors are contiguous I32 [B]. B>=1, 1<=K<=31 (up to 63 at B=1), 1<=P<=15,
 *   0<=accepted[b]<=K,
 *   licensed_counts[b]=accepted[b]+1, updated_frontiers and remaining_budgets are non-negative,
 *   and max_context is positive. The Op writes every output slot, including safe invalid-tail
 *   values. Inputs remain unchanged. No workspace or other state is used.
 */
void mtp_prepare_next_round(const Tensor& verify_ids, const Tensor& next_anchors,
                            const Tensor& accepted, const Tensor& updated_frontiers,
                            const Tensor& logical_frontiers, const Tensor& remaining_budgets,
                            const Tensor& licensed_counts, const Tensor& rope_deltas,
                            Tensor& alignment_ids, Tensor& next_extents, Tensor& ar_positions,
                            Tensor& ar_rope_positions, Tensor& ar_valid_columns,
                            std::int32_t proposal_drafts, std::int32_t max_context,
                            cudaStream_t stream);

} // namespace ninfer::ops
