// Standalone GPU qualification for MeanKIndex::append_committed_slice.
//
// SCOPE (do not overclaim): this verifies that two INDEPENDENT MeanKIndex owners consuming
// different row slices of ONE shared harvest accumulate exactly their own committed prefix, with
// an independent constant-input oracle for every sum/count cell. It does NOT claim to exercise
// real dual-sequence concurrency (two streams, two harvests, interleaved decode): the index calls
// here are issued on a single stream one after another.
#include "core/device.h"
#include "ops/kvmem/mean_k_index.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

using namespace ninfer;
using namespace ninfer::ops;

namespace {
constexpr int layers = 2, heads = 4, dim = 256, blocks = 8, width = heads * dim;
constexpr int harvest_tokens = 128, round = 8, page_tokens = 64;

void require(bool value, const char* message) {
    if (!value) { throw std::runtime_error(message); }
}

std::vector<std::uint16_t> bf16_row(std::uint16_t bits, int tokens) {
    return std::vector<std::uint16_t>(static_cast<std::size_t>(tokens) * width, bits);
}

void upload_round(RawKShadowHarvest& store, const std::vector<std::uint16_t>& data) {
    require(static_cast<int>(data.size()) == round * width, "round fixture has the wrong size");
    for (int layer = 0; layer < layers; ++layer) {
        const Tensor view = store.staging_for_round(layer);
        require(view.data != nullptr, "harvest staging is not allocated");
        CUDA_CHECK(cudaMemcpy(view.data, data.data(), data.size() * sizeof(std::uint16_t),
                              cudaMemcpyHostToDevice));
    }
}

// Independent exact oracle: constant BF16 rows are integers, so each page's F32 sum cell must be
// exactly count[page] * value[page] and every other page must stay untouched (count 0, sum 0).
void check_exact(MeanKIndex& index, const std::vector<int>& expected_count,
                 const std::vector<float>& expected_value) {
    require(expected_count.size() == blocks && expected_value.size() == blocks,
            "oracle table has the wrong size");
    for (int layer = 0; layer < layers; ++layer) {
        std::vector<float> sums(static_cast<std::size_t>(blocks) * width), counts(blocks);
        CUDA_CHECK(cudaMemcpy(sums.data(), index.layer_sums(layer).data,
                              sums.size() * sizeof(float), cudaMemcpyDefault));
        CUDA_CHECK(cudaMemcpy(counts.data(), index.layer_counts(layer).data,
                              counts.size() * sizeof(float), cudaMemcpyDefault));
        for (int page = 0; page < blocks; ++page) {
            require(counts[page] == static_cast<float>(expected_count[page]),
                    "index count differs from the independent oracle");
            const float expected = static_cast<float>(expected_count[page]) * expected_value[page];
            for (int cell = 0; cell < width; ++cell) {
                require(sums[static_cast<std::size_t>(page) * width + cell] == expected,
                        "index sum differs from the independent oracle");
            }
        }
    }
}

struct Snapshot {
    std::vector<std::vector<float>> sums, counts;
};

Snapshot snapshot(const MeanKIndex& index) {
    Snapshot state;
    for (int layer = 0; layer < layers; ++layer) {
        std::vector<float> sums(static_cast<std::size_t>(blocks) * width), counts(blocks);
        CUDA_CHECK(cudaMemcpy(sums.data(), index.layer_sums(layer).data,
                              sums.size() * sizeof(float), cudaMemcpyDefault));
        CUDA_CHECK(cudaMemcpy(counts.data(), index.layer_counts(layer).data,
                              counts.size() * sizeof(float), cudaMemcpyDefault));
        state.sums.push_back(std::move(sums));
        state.counts.push_back(std::move(counts));
    }
    return state;
}

void check_unchanged(const MeanKIndex& index, const Snapshot& before, const char* message) {
    const Snapshot after = snapshot(index);
    require(after.sums == before.sums && after.counts == before.counts, message);
}

void run() {
    RawKShadowHarvest store(layers, width, harvest_tokens);
    store.set_round_width(round);
    // Rows 0..3: +1.0 (0x3f80). Rows 4..7: -2.0 (0xc000). This is the shared source for both
    // consumers; each one selects its own row_offset window.
    std::vector<std::uint16_t> round_data = bf16_row(0x3f80, 4);
    const std::vector<std::uint16_t> negative = bf16_row(0xc000, 4);
    round_data.insert(round_data.end(), negative.begin(), negative.end());
    upload_round(store, round_data);

    cudaStream_t stream = nullptr;
    CUDA_CHECK(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
    try {
        MeanKIndex a(layers, heads, dim, blocks), b(layers, heads, dim, blocks);
        require(!a.empty() && !b.empty(), "index allocation stayed empty");
        require(a.zero(stream) == cudaSuccess && b.zero(stream) == cudaSuccess, "zero failed");

        // Two independent indexes over the same harvest: A takes rows [0,4) and commits 3;
        // B takes rows [4,8) and commits 1. Only the committed prefix may enter each index.
        a.append_committed_slice(store, 0, 0, 4, 3, stream);
        b.append_committed_slice(store, 4, 0, 4, 1, stream);
        CUDA_CHECK(cudaStreamSynchronize(stream));

        std::vector<int> count_a(blocks, 0), count_b(blocks, 0);
        std::vector<float> value_a(blocks, 0.0f), value_b(blocks, 0.0f);
        count_a[0] = 3; value_a[0] = 1.0f;
        count_b[0] = 1; value_b[0] = -2.0f;
        check_exact(a, count_a, value_a);
        check_exact(b, count_b, value_b);
        require(a.blocks_written() == 1 && a.tail_fill() == 3, "A cursor mismatch");
        require(b.blocks_written() == 1 && b.tail_fill() == 1, "B cursor mismatch");

        // Zero commits are a no-op: the geometry is valid but nothing is history.
        a.append_committed_slice(store, 0, 3, 4, 0, stream);
        CUDA_CHECK(cudaStreamSynchronize(stream));
        check_exact(a, count_a, value_a);
        require(a.tail_fill() == 3, "zero commit advanced the A cursor");

        // A replayed token_base must not double count: the suffix is already indexed.
        a.append_committed_slice(store, 0, 0, 4, 3, stream);
        CUDA_CHECK(cudaStreamSynchronize(stream));
        check_exact(a, count_a, value_a);
        require(a.blocks_written() == 1 && a.tail_fill() == 3, "replay advanced the A cursor");

        // Cross the 64-token page boundary: tokens [60,68) split 4 (+1) / 4 (-2) between pages
        // 0 and 1 from a freshly zeroed index.
        MeanKIndex crossing(layers, heads, dim, blocks);
        require(crossing.zero(stream) == cudaSuccess, "crossing zero failed");
        crossing.append_committed_slice(store, 0, 60, round, round, stream);
        CUDA_CHECK(cudaStreamSynchronize(stream));
        std::vector<int> count_c(blocks, 0);
        std::vector<float> value_c(blocks, 0.0f);
        count_c[0] = 4; value_c[0] = 1.0f;
        count_c[1] = 4; value_c[1] = -2.0f;
        check_exact(crossing, count_c, value_c);
        require(crossing.blocks_written() == 2 && crossing.tail_fill() == 68 % page_tokens,
                "crossing cursor mismatch");

        // Rejected geometry must leave BOTH indexes byte-identical. Snapshot the other index
        // (A) as well as the target (B) before the failing calls.
        const Snapshot before_a = snapshot(a);
        const Snapshot before_b = snapshot(b);
        auto rejected = [&store, stream](const char* what, auto&& call, bool out_of_range) {
            bool threw = false;
            try {
                call();
            } catch (const std::invalid_argument&) {
                threw = !out_of_range;
            } catch (const std::out_of_range&) {
                threw = out_of_range;
            }
            require(threw, what);
        };
        rejected("negative row_offset must be rejected",
                 [&] { b.append_committed_slice(store, -1, 0, 4, 1, stream); }, false);
        rejected("slice wider than round_width must be rejected",
                 [&] { b.append_committed_slice(store, 6, 0, 4, 1, stream); }, false);
        rejected("negative token_base must be rejected",
                 [&] { b.append_committed_slice(store, 0, -4, round, round, stream); }, true);
        CUDA_CHECK(cudaStreamSynchronize(stream));
        check_unchanged(a, before_a, "failed slice call modified the other index");
        check_unchanged(b, before_b, "failed slice call modified the target index");

        std::puts("PASS: shared harvest consumed by two independent indexes, exact sum/count "
                  "oracles, zero/no-replay commits, 64-token page crossing, geometry rejection "
                  "with untouched snapshots (single stream; parallel decode not exercised)");
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
#else
    setenv("NINFER_TERNARY_KVMEM", "1", 1);
#endif
    try {
        run();
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FAIL: %s\n", error.what());
        return 1;
    }
}