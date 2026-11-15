#include "core/device.h"
#include "ops/kvmem/retrieval_workspace.h"

#include <algorithm>
#include <bit>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <vector>

using namespace ninfer;
using namespace ninfer::ops;

namespace {
constexpr int layers = 2, heads = 4, dim = 256, blocks = 8, width = heads * dim;
void require(bool value, const char* message) {
    if (!value) { throw std::runtime_error(message); }
}

void check_index(MeanKIndex& index, int tokens, float value) {
    // Independent exact oracle: constant BF16 inputs sum to integer-valued F32
    // cells; validate every cell and count, including unwritten/tail pages.
    for (int layer = 0; layer < layers; ++layer) {
        std::vector<float> sums(blocks * width), counts(blocks);
        CUDA_CHECK(cudaMemcpy(sums.data(), index.layer_sums(layer).data,
                              sums.size() * sizeof(float), cudaMemcpyDefault));
        CUDA_CHECK(cudaMemcpy(counts.data(), index.layer_counts(layer).data,
                              counts.size() * sizeof(float), cudaMemcpyDefault));
        for (int page = 0; page < blocks; ++page) {
            const int count = std::clamp(tokens - page * 64, 0, 64);
            require(counts[page] == count, "workspace count contaminated by another history");
            for (int cell = 0; cell < width; ++cell) {
                require(sums[page * width + cell] == count * value,
                        "workspace sum differs from its own represented-input oracle");
            }
        }
    }
}

void run() {
    auto a = std::make_unique<RetrievalWorkspace>();
    RetrievalWorkspace b;
    a->bind();
    require(!a->index && !a->harvest && &detail::kvmem_score_probe() == &a->probe,
            "bind must not allocate and must bind the matching score state");
    auto* ia = mean_k_index_for(layers, heads, dim, blocks);
    auto* ha = raw_k_shadow_harvest_for(128, width, layers);
    a->probe.generation = 7;
    a->probe.kept = {1, 3};
    detail::kvmem_score_set_query_span(64, 128);
    b.bind();
    auto* ib = mean_k_index_for(layers, heads, dim, blocks);
    auto* hb = raw_k_shadow_harvest_for(128, width, layers);
    b.probe.generation = 19;
    b.probe.kept = {2, 4};
    detail::kvmem_score_set_query_span(256, 300);
    require(ia != ib && ha != hb, "contexts share mutable index/harvest storage");

    std::vector<std::uint16_t> ones(width * 63, 0x3f80), negative(width * 63, 0xc000);
    DeviceBuffer ra(ones.size() * sizeof(std::uint16_t)), rb(negative.size() * sizeof(std::uint16_t));
    ra.copy_from_host(ones.data(), ra.bytes);
    rb.copy_from_host(negative.data(), rb.bytes);
    cudaStream_t sa = nullptr, sb = nullptr;
    CUDA_CHECK(cudaStreamCreateWithFlags(&sa, cudaStreamNonBlocking));
    CUDA_CHECK(cudaStreamCreateWithFlags(&sb, cudaStreamNonBlocking));
    try {
        auto append = [](RetrievalWorkspace& workspace, DeviceBuffer& raw,
                         int first, int count, cudaStream_t stream) {
            workspace.bind();
            require(mean_k_index_for(layers, heads, dim, blocks) == workspace.index.get(),
                    "rebind selected the wrong index owner");
            require(raw_k_shadow_harvest_for(128, width, layers) == workspace.harvest.get(),
                    "rebind selected the wrong harvest owner");
            for (int layer = 0; layer < layers; ++layer) {
                workspace.index->append_layer(Tensor(raw.p, DType::BF16, {width, count}),
                                               layer, count, first, stream);
            }
        };
        append(*a, ra, 0, 63, sa);
        append(b, rb, 0, 2, sb);
        for (int round = 0; round < 30; ++round) {
            append(*a, ra, 63 + round, 1, sa);
            append(b, rb, 2 + round * 2, 2, sb);
        }
        CUDA_CHECK(cudaStreamSynchronize(sa));
        CUDA_CHECK(cudaStreamSynchronize(sb));
        check_index(*ia, 93, 1.0f);
        check_index(*ib, 62, -2.0f);
        a->bind();
        require(a->probe.generation == 7 && a->probe.kept == std::vector<int>({1, 3}) &&
                detail::kvmem_score_probe().abs_query_begin == 64,
                "query/ranking state crossed a workspace boundary");
        b.bind();
        require(b.probe.generation == 19 && b.probe.kept == std::vector<int>({2, 4}) &&
                detail::kvmem_score_probe().abs_query_begin == 256,
                "second query/ranking changed during first context execution");
        a.reset(); // cancellation/release of an inactive execution owner
        require(&detail::kvmem_score_probe() == &b.probe &&
                mean_k_index_for(layers, heads, dim, blocks) == ib,
                "destroying inactive context detached the current one");
        check_index(*ib, 62, -2.0f);
        b.unbind_if_current();
        require(detail::bound_score_probe == nullptr, "active owner left a dangling binding");
    } catch (...) {
        (void)cudaDeviceSynchronize();
        (void)cudaStreamDestroy(sa); (void)cudaStreamDestroy(sb);
        throw;
    }
    CUDA_CHECK(cudaStreamDestroy(sa)); CUDA_CHECK(cudaStreamDestroy(sb));
    std::puts("PASS: 62 interleaved appends, two independent CUDA streams, exact index/count oracle, query isolation and inactive-owner release");
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
