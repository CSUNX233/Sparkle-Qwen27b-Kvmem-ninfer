#include "models/qwen3_5/execution/workspace.h"
#include "models/qwen3_5/program/speculative/mtp_alignment.h"
#include "ninfer/ops/scatter.h"
#include "ops/launcher/scatter.h"

#include <array>
#include <cstdint>
#include <initializer_list>
#include <iostream>
#include <stdexcept>

using namespace ninfer;
using namespace ninfer::models::qwen3_5;

namespace {
alignas(256) std::array<std::uint8_t, 2 * 1024 * 1024> storage{};
bool launched = false;
void require(bool ok) { if (!ok) throw std::runtime_error("visual boundary regression failed"); }
struct FakeAllocator {
    std::size_t used = 0;
    Tensor alloc(DType dtype, std::initializer_list<std::int32_t> shape) {
        std::size_t elements = 1;
        for (auto n : shape) elements *= static_cast<std::size_t>(n);
        used = (used + 255U) & ~std::size_t{255U};
        used += elements * dtype_size(dtype);
        return Tensor(storage.data(), dtype, shape);
    }
};
}

namespace ninfer::ops::detail {
void scatter_launch(const Tensor&, const Tensor&, Tensor&, cudaStream_t) { launched = true; }
void scatter_bf16_batch_launch(const Tensor&, const Tensor&, const Tensor&, Tensor&, cudaStream_t) {}
}

int main() {
    TextConfig config{};
    config.hidden_size = 5120;
    FakeAllocator allocator;
    const std::array<std::int32_t, 2> visual_positions{128, 129};
    const auto window = plan_mtp_alignment_window(256, 0, 128);
    const auto overlap = shifted_visual_overlap(visual_positions, 256, window);
    require(overlap.size() == 1 && overlap.source_begin == 0 && overlap.destination_columns[0] == 127);

    const auto roots = execution::workspace::text_prefill_roots(allocator, config, 128, 3, 0, true);
    Tensor source = roots.visual_embeddings.slice(1, 0, 1);
    Tensor indices(storage.data(), DType::I32, {1});
    Tensor destination(storage.data(), DType::BF16, {5120, 128});
    try { ops::scatter(source, indices, destination, nullptr); }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 7; }
    require(launched && source.ne[0] == 5120 && source.ne[1] == 1);

    const auto normal = execution::workspace::text_prefill_roots(allocator, config, 128, 3, 2, true);
    require(normal.visual_embeddings.ne[0] == 5120 && normal.visual_embeddings.ne[1] == 3);
    const auto no_overlay = execution::workspace::text_prefill_roots(allocator, config, 128, 3, 0, false);
    require(no_overlay.visual_embeddings.data == nullptr);
    FakeAllocator boundary_layout, largest_layout;
    (void)execution::workspace::text_prefill_roots(boundary_layout, config, 128, 3, 0, true);
    (void)execution::workspace::text_prefill_roots(largest_layout, config, 128, 3, 128, true);
    require(boundary_layout.used < largest_layout.used);
    std::cout << "boundary and normal visual staging shapes passed\n";
}
