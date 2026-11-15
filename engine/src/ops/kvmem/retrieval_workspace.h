// Modified in the CSUNX233 distribution. See docs/KVMEM_DUAL_LANE_RESEARCH.md.
#pragma once

#include "ops/kvmem/kvmem_score.h"
#include "ops/kvmem/mean_k_index.h"
#include "ops/kvmem/raw_k_harvest.h"

#include <memory>

namespace ninfer::ops {

// One mutable retrieval execution context. Keep index and query/score state
// together: rebinding only one of them silently mixes two histories. The raw-K
// staging buffer is deliberately NOT part of that per-lane bundle in a Program:
// one captured decode graph replays whichever lane is active and therefore has
// to write one stable staging address, so ProgramImpl owns one buffer and every
// lane borrows it through bind_with_harvest(). This first-stage refactor does
// NOT enable multi-lane decode or make captured graphs lane-safe. The caller
// must finish outstanding execution before reuse or destruction, exactly as
// ProgramImpl did for the original three members.
class RetrievalWorkspace {
public:
    RetrievalWorkspace() = default;
    RetrievalWorkspace(const RetrievalWorkspace&) = delete;
    RetrievalWorkspace& operator=(const RetrievalWorkspace&) = delete;
    RetrievalWorkspace(RetrievalWorkspace&&) = delete;
    RetrievalWorkspace& operator=(RetrievalWorkspace&&) = delete;

    ~RetrievalWorkspace() { unbind_if_current(); }

    void bind() noexcept { bind_with_harvest(harvest); }

    // Bind this context's index and query/score state together with a staging
    // buffer owned elsewhere. A Program uses ONE staging buffer for every lane:
    // a captured decode graph bakes the staging address, and one graph serves all
    // lanes, while only the index and the query/score state are per lane. The
    // borrowed owner is still the lazy-allocation target, so the first
    // raw_k_shadow_harvest_for() call allocates into it exactly as bind() does.
    void bind_with_harvest(std::unique_ptr<RawKShadowHarvest>& harvest_owner) noexcept {
        raw_k_shadow_harvest_bind(&harvest_owner);
        mean_k_index_bind(&index);
        detail::kvmem_score_bind(&probe);
    }

    void unbind_if_current() noexcept {
        // Destroying an inactive context must not detach a different live one.
        if (detail::bound_score_probe != &probe) { return; }
        detail::kvmem_score_bind(nullptr);
        mean_k_index_bind(nullptr);
        raw_k_shadow_harvest_bind(nullptr);
    }

    // Retain the old member order and lazy allocation policy. Binding an empty
    // workspace allocates no CUDA or pinned Host memory.
    std::unique_ptr<RawKShadowHarvest> harvest;
    std::unique_ptr<MeanKIndex> index;
    detail::KvMemScoreProbe probe;
};

} // namespace ninfer::ops
