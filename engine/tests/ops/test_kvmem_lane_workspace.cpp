// Per-lane retrieval contexts over ONE shared raw-K staging buffer.
//
// SCOPE (do not overclaim): this verifies the storage split the dual-lane port needs -- two
// RetrievalWorkspace owners, each with its own MeanKIndex and query/score probe, consuming their
// own row slice of the same harvest staging. It does NOT exercise two model requests, two captured
// graphs, or two overlapping kernels; it is a GPU oracle for index ownership and slice geometry.
#include "core/device.h"
#include "ops/kvmem/retrieval_workspace.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

using namespace ninfer;
using namespace ninfer::ops;

namespace {
constexpr int layers = 2, heads = 4, dim = 256, blocks = 8, width = heads * dim;
constexpr int harvest_tokens = 128, batch_rows = 2, page_tokens = 64;

void require(bool value, const char* message) {
    if (!value) { throw std::runtime_error(message); }
}

std::vector<std::uint16_t> bf16_row(std::uint16_t bits, int rows) {
    return std::vector<std::uint16_t>(static_cast<std::size_t>(rows) * width, bits);
}

void upload_batch(RawKShadowHarvest& staging, const std::vector<std::uint16_t>& data) {
    require(static_cast<int>(data.size()) == batch_rows * width, "batch fixture has the wrong size");
    for (int layer = 0; layer < layers; ++layer) {
        const Tensor view = staging.staging_for_round(layer);
        require(view.data != nullptr, "shared staging is not allocated");
        CUDA_CHECK(cudaMemcpy(view.data, data.data(), data.size() * sizeof(std::uint16_t),
                              cudaMemcpyHostToDevice));
    }
}

// Independent exact oracle: constant BF16 rows are integers, so a page's F32 sum cell must be
// exactly count[page] * value[page] and every untouched page must stay at zero.
void check_exact(MeanKIndex& index, int tokens, float value) {
    for (int layer = 0; layer < layers; ++layer) {
        std::vector<float> sums(static_cast<std::size_t>(blocks) * width), counts(blocks);
        CUDA_CHECK(cudaMemcpy(sums.data(), index.layer_sums(layer).data,
                              sums.size() * sizeof(float), cudaMemcpyDefault));
        CUDA_CHECK(cudaMemcpy(counts.data(), index.layer_counts(layer).data,
                              counts.size() * sizeof(float), cudaMemcpyDefault));
        for (int page = 0; page < blocks; ++page) {
            const int count = std::clamp(tokens - page * page_tokens, 0, page_tokens);
            require(counts[page] == static_cast<float>(count),
                    "lane index count crossed into another lane's history");
            const float expected = static_cast<float>(count) * value;
            for (int cell = 0; cell < width; ++cell) {
                require(sums[static_cast<std::size_t>(page) * width + cell] == expected,
                        "lane index sum differs from its own row-slice oracle");
            }
        }
    }
}

void run() {
    // One staging owner for the Program; the two contexts own only index + probe.
    auto staging = std::make_unique<RawKShadowHarvest>(layers, width, harvest_tokens);
    auto lane_a  = std::make_unique<RetrievalWorkspace>();
    auto lane_b  = std::make_unique<RetrievalWorkspace>();

    lane_a->bind_with_harvest(staging);
    require(raw_k_shadow_harvest_for(harvest_tokens, width, layers) == staging.get(),
            "lane A did not borrow the shared staging owner");
    auto* index_a = mean_k_index_for(layers, heads, dim, blocks);
    require(index_a != nullptr && !index_a->empty(), "lane A index allocation failed");

    lane_b->bind_with_harvest(staging);
    require(raw_k_shadow_harvest_for(harvest_tokens, width, layers) == staging.get(),
            "lane B did not borrow the shared staging owner");
    auto* index_b = mean_k_index_for(layers, heads, dim, blocks);
    require(index_b != nullptr && !index_b->empty(), "lane B index allocation failed");
    require(index_a != index_b, "lanes share one mutable MeanKIndex");

    // The probe state must never cross a lane bind. The span setter writes the
    // BOUND probe, so each lane must be bound before publishing its query.
    lane_a->bind_with_harvest(staging);
    lane_a->probe.generation = 3;
    lane_a->probe.kept       = {1};
    detail::kvmem_score_set_query_span(10, 20);
    lane_b->bind_with_harvest(staging);
    lane_b->probe.generation = 9;
    lane_b->probe.kept       = {4};
    detail::kvmem_score_set_query_span(30, 40);
    lane_a->bind_with_harvest(staging);
    require(lane_a->probe.generation == 3 && lane_a->probe.kept == std::vector<std::int32_t>({1}) &&
                detail::kvmem_score_probe().abs_query_begin == 10,
            "lane A query state was contaminated by lane B");
    lane_b->bind_with_harvest(staging);
    require(lane_b->probe.generation == 9 && lane_b->probe.kept == std::vector<std::int32_t>({4}) &&
                detail::kvmem_score_probe().abs_query_begin == 30,
            "lane B query state was contaminated by lane A");

    cudaStream_t stream = nullptr;
    CUDA_CHECK(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
    try {
        // A decode batch writes row 0 for lane A and row 1 for lane B into the SAME staging.
        staging->set_round_width(batch_rows);
        std::vector<std::uint16_t> first = bf16_row(0x3f80, 1);            // +1.0
        const std::vector<std::uint16_t> negative = bf16_row(0xc000, 1);   // -2.0
        first.insert(first.end(), negative.begin(), negative.end());
        upload_batch(*staging, first);

        lane_a->bind_with_harvest(staging);
        lane_a->index->append_committed_slice(*staging, 0, 0, 1, 1, stream);
        lane_b->bind_with_harvest(staging);
        lane_b->index->append_committed_slice(*staging, 1, 0, 1, 1, stream);
        CUDA_CHECK(cudaStreamSynchronize(stream));

        check_exact(*lane_a->index, 1, 1.0f);
        check_exact(*lane_b->index, 1, -2.0f);
        require(lane_a->index->blocks_written() == 1 && lane_a->index->tail_fill() == 1,
                "lane A cursor mismatch");
        require(lane_b->index->blocks_written() == 1 && lane_b->index->tail_fill() == 1,
                "lane B cursor mismatch");

        // Second round at absolute token 1: each lane must extend ONLY its own history.
        upload_batch(*staging, first);
        lane_a->index->append_committed_slice(*staging, 0, 1, 1, 1, stream);
        lane_b->index->append_committed_slice(*staging, 1, 1, 1, 1, stream);
        CUDA_CHECK(cudaStreamSynchronize(stream));
        check_exact(*lane_a->index, 2, 1.0f);
        check_exact(*lane_b->index, 2, -2.0f);

        // A row outside the staged width is rejected and leaves BOTH indexes byte-identical.
        std::vector<float> before_a(static_cast<std::size_t>(blocks) * width);
        CUDA_CHECK(cudaMemcpy(before_a.data(), lane_a->index->layer_sums(0).data,
                              before_a.size() * sizeof(float), cudaMemcpyDefault));
        bool rejected = false;
        try {
            lane_b->index->append_committed_slice(*staging, batch_rows, 2, 1, 1, stream);
        } catch (const std::invalid_argument&) {
            rejected = true;
        }
        require(rejected, "a slice past the staged rows must be rejected");
        CUDA_CHECK(cudaStreamSynchronize(stream));
        std::vector<float> after_a(before_a.size());
        CUDA_CHECK(cudaMemcpy(after_a.data(), lane_a->index->layer_sums(0).data,
                              after_a.size() * sizeof(float), cudaMemcpyDefault));
        require(before_a == after_a, "a rejected slice modified the other lane's index");
        check_exact(*lane_b->index, 2, -2.0f);

        // Releasing an INACTIVE lane must not detach the active one.
        lane_b->bind_with_harvest(staging);
        lane_a.reset();
        require(&detail::kvmem_score_probe() == &lane_b->probe &&
                    mean_k_index_for(layers, heads, dim, blocks) == index_b,
                "destroying an inactive lane detached the active lane");
        check_exact(*lane_b->index, 2, -2.0f);
        lane_b->unbind_if_current();
        require(detail::bound_score_probe == nullptr, "active lane left a dangling binding");
        std::puts("PASS: two lane contexts over one shared staging, exact per-lane row-slice sums, "
                  "query isolation, rejected-slice rollback, inactive-lane release");
    } catch (...) {
        (void)cudaDeviceSynchronize();
        (void)cudaStreamDestroy(stream);
        throw;
    }
    CUDA_CHECK(cudaStreamDestroy(stream));
}
} // namespace

int main() {
#ifdef _WIN32
    _putenv_s("NINFER_TERNARY_KVMEM", "1");
    _putenv_s("NINFER_TERNARY_KVMEM_SCORE", "1");
#else
    setenv("NINFER_TERNARY_KVMEM", "1", 1);
    setenv("NINFER_TERNARY_KVMEM_SCORE", "1", 1);
#endif
    try {
        run();
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FAIL: %s\n", error.what());
        return 1;
    }
}