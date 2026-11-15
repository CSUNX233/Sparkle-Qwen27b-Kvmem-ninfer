// Compact execution view (upstream KVMem/NInfer model) at the page-store level.
//
// SCOPE: verifies that KVAddressSpaceStore::rebuild_compact turns a logical address
// into a dense view of a selected page subset WITHOUT moving KV bytes: compact slot
// order, execution-table row, partial tail, descriptor/physical-page reclamation, growth
// after a rebuild, and geometry/membership rejection. It does NOT run model attention
// or prove that a full Program can decode from the compact view yet.
#include "core/device.h"
#include "models/qwen3_5/program/storage/kv_store.h"
#include "models/qwen3_5/program/storage/compact_selection.h"

#include <cuda_runtime.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <string_view>
#include <vector>

namespace {

namespace store = ninfer::models::qwen3_5::detail;

int failures = 0;

void expect(bool condition, std::string_view message) {
    if (condition) { return; }
    ++failures;
    std::fprintf(stderr, "FAIL: %.*s\n", static_cast<int>(message.size()), message.data());
}

std::vector<std::int32_t> read_row(const ninfer::KVExecutionTablePool& tables, std::int32_t row,
                                   std::size_t count) {
    const ninfer::Tensor source = tables.matrix().slice(1, row, 1).view(
        {static_cast<std::int32_t>(tables.logical_page_capacity())});
    std::vector<std::int32_t> values(count);
    CUDA_CHECK(cudaMemcpy(values.data(), source.data, values.size() * sizeof(std::int32_t),
                          cudaMemcpyDeviceToHost));
    return values;
}

unsigned char read_first_byte(const ninfer::DeviceKVPagePool& pool, std::int32_t physical_index) {
    const ninfer::Tensor& plane = pool.plane(0);
    unsigned char value         = 0;
    CUDA_CHECK(cudaMemcpy(&value,
                          static_cast<const unsigned char*>(plane.data) +
                              static_cast<std::size_t>(physical_index) * plane.nb[3],
                          1, cudaMemcpyDeviceToHost));
    return value;
}

void test_compact_view(ninfer::DeviceContext& device) {
    ninfer::LayoutBuilder builder;
    ninfer::DeviceKVPagePoolSpec spec{
        .page_group_count = 12,
        .allow_logical_reservation = true,
        .geometry = {.page_tokens = 64,
                     .device_plane_order = ninfer::PagedKVPlaneOrder::PageMajor,
                     .planes = {{.dtype = ninfer::DType::BF16, .leading_extent = 8,
                                 .head_extent = 2}}},
    };
    const auto layout = ninfer::plan_device_kv_page_pool(builder, spec);
    const auto table_layout =
        ninfer::plan_kv_execution_tables(builder, {.logical_page_capacity = 16,
                                                    .table_rows = 2});
    ninfer::DeviceArena arena(builder.finish(256));
    const ninfer::DeviceSpan backing{arena.base(), arena.capacity()};
    ninfer::DeviceKVPagePool physical(backing, layout);
    ninfer::KVExecutionTablePool tables(backing, table_layout, physical);
    store::LogicalKVPageStore pages(physical, 40);
    store::KVAddressSpaceStore addresses(pages, tables, 4, 16);

    const auto address = addresses.create_active(8, 0, {});
    expect(address.has_value(), "compact fixture address");
    if (!address) { return; }
    addresses.ensure_mapped_to_tokens(*address, 8 * 64, device.stream);
    addresses.commit_frontier(*address, 5 * 64 + 17);
    device.synchronize();

    const auto before = read_row(tables, 0, 8);
    for (int page = 0; page < 6; ++page) {
        const ninfer::Tensor& plane = physical.plane(0);
        CUDA_CHECK(cudaMemsetAsync(
            static_cast<unsigned char*>(plane.data) +
                static_cast<std::size_t>(before[page]) * plane.nb[3],
            0x40 + page, plane.nb[3], device.stream));
    }
    device.synchronize();

    const std::array<store::LogicalKVPageHandle, 3> selected{
        addresses.logical_page(*address, 0),
        addresses.logical_page(*address, 2),
        addresses.logical_page(*address, 5),
    };
    const std::array<store::LogicalKVPageHandle, 3> dropped{
        addresses.logical_page(*address, 1),
        addresses.logical_page(*address, 3),
        addresses.logical_page(*address, 4),
    };
    // 64 + 64 + 17: the compact tail carries page 5's partial committed columns.
    addresses.rebuild_compact(*address, selected, 64 + 64 + 17, device.stream);
    device.synchronize();

    expect(addresses.mapped_pages(*address) == 3,
           "compact view maps exactly the selected pages");
    expect(addresses.logical_page(*address, 0) == selected[0] &&
               addresses.logical_page(*address, 1) == selected[1] &&
               addresses.logical_page(*address, 2) == selected[2],
           "compact slots keep the selected order");
    const auto after = read_row(tables, 0, 3);
    expect(after[0] == before[0] && after[1] == before[2] && after[2] == before[5],
           "execution row points at the selected physical pages");
    expect(read_first_byte(physical, after[0]) == 0x40 &&
               read_first_byte(physical, after[1]) == 0x42 &&
               read_first_byte(physical, after[2]) == 0x45,
           "selected page bytes did not move");
    expect(!pages.valid(dropped[0]) && !pages.valid(dropped[1]) && !pages.valid(dropped[2]),
           "unselected sole-owner pages release their descriptors");
    expect(physical.allocated_pages() == 3,
           "unselected physical pages return to the pool");

    const auto reject = [&](auto&& call, const char* message) {
        bool threw = false;
        try {
            call();
        } catch (const std::invalid_argument&) { threw = true; }
        expect(threw, message);
    };
    // A repeated page is rejected (65 tokens keeps the geometry check out of the way).
    const std::array<store::LogicalKVPageHandle, 2> repeated{selected[0], selected[0]};
    reject([&] { addresses.rebuild_compact(*address, repeated, 65, device.stream); },
           "a repeated selected page is rejected");
    const std::array<store::LogicalKVPageHandle, 3> three{selected[0], selected[1], selected[2]};
    reject([&] { addresses.rebuild_compact(*address, three, 2 * 64, device.stream); },
           "a zero-token tail page is rejected");
    reject([&] { addresses.rebuild_compact(*address, three, 3 * 64 + 1, device.stream); },
           "a frontier wider than the selected pages is rejected");
    // Page 5 still has its 17 committed columns here; 18 exceeds them.
    reject([&] { addresses.rebuild_compact(*address, three, 64 + 64 + 18, device.stream); },
           "a frontier wider than the tail page's committed columns is rejected");

    // Growing after a compact view appends at the next compact slot, not at the
    // old logical page index.
    addresses.ensure_mapped_to_tokens(*address, 200, device.stream);
    addresses.commit_frontier(*address, 200);
    device.synchronize();
    expect(addresses.mapped_pages(*address) == 4, "compact view grows after the rebuild");
    expect(addresses.logical_page(*address, 3).valid(), "appended compact slot is populated");

    const auto other = addresses.create_active(1, 1, {});
    expect(other.has_value(), "compact fixture second address");
    if (other) {
        addresses.ensure_mapped_to_tokens(*other, 64, device.stream);
        const std::array<store::LogicalKVPageHandle, 1> foreign{
            addresses.logical_page(*other, 0)};
        reject([&] { addresses.rebuild_compact(*address, foreign, 64, device.stream); },
               "a page outside the address is rejected");
        expect(addresses.mapped_pages(*address) == 4,
               "a rejected rebuild leaves the address unchanged");
    }
}
void test_publish_compact_view(ninfer::DeviceContext& device) {
    ninfer::LayoutBuilder builder;
    ninfer::DeviceKVPagePoolSpec spec{
        .page_group_count = 12,
        .allow_logical_reservation = true,
        .geometry = {.page_tokens = 64,
                     .device_plane_order = ninfer::PagedKVPlaneOrder::PageMajor,
                     .planes = {{.dtype = ninfer::DType::BF16, .leading_extent = 8,
                                 .head_extent = 2}}},
    };
    const auto layout = ninfer::plan_device_kv_page_pool(builder, spec);
    const auto table_layout =
        ninfer::plan_kv_execution_tables(builder, {.logical_page_capacity = 16,
                                                    .table_rows = 2});
    ninfer::DeviceArena arena(builder.finish(256));
    const ninfer::DeviceSpan backing{arena.base(), arena.capacity()};
    ninfer::DeviceKVPagePool physical(backing, layout);
    ninfer::KVExecutionTablePool tables(backing, table_layout, physical);
    store::LogicalKVPageStore pages(physical, 40);
    store::KVAddressSpaceStore addresses(pages, tables, 4, 16);

    const auto address = addresses.create_active(8, 0, {});
    expect(address.has_value(), "publish-view fixture address");
    if (!address) { return; }
    addresses.ensure_mapped_to_tokens(*address, 8 * 64, device.stream);
    addresses.commit_frontier(*address, 5 * 64 + 17);
    device.synchronize();

    const auto before = read_row(tables, 0, 8);
    for (int page : {0, 2, 5, 6}) {
        const ninfer::Tensor& plane = physical.plane(0);
        CUDA_CHECK(cudaMemsetAsync(
            static_cast<unsigned char*>(plane.data) +
                static_cast<std::size_t>(before[page]) * plane.nb[3],
            0x50 + page, plane.nb[3], device.stream));
    }
    device.synchronize();
    const std::array<store::LogicalKVPageHandle, 8> original{
        addresses.logical_page(*address, 0), addresses.logical_page(*address, 1),
        addresses.logical_page(*address, 2), addresses.logical_page(*address, 3),
        addresses.logical_page(*address, 4), addresses.logical_page(*address, 5),
        addresses.logical_page(*address, 6), addresses.logical_page(*address, 7)};

    const std::array<std::uint32_t, 3> first{0, 2, 5};
    // Page 5 is the partial tail (17 columns), so it must be the LAST selected page.
    addresses.publish_compact_view(*address, first, 64 + 64 + 17, device.stream);
    device.synchronize();

    expect(addresses.mapped_pages(*address) == 8,
           "publishing a compact view leaves the logical address intact");
    for (std::uint32_t page = 0; page < 8; ++page) {
        expect(addresses.logical_page(*address, page) == original[page],
               "compact publication does not reorder logical members");
    }
    const auto first_row = read_row(tables, 0, 3);
    expect(first_row[0] == before[0] && first_row[1] == before[2] && first_row[2] == before[5],
           "compact publication writes the selected physical pages to the row");
    expect(read_first_byte(physical, first_row[0]) == 0x50 &&
               read_first_byte(physical, first_row[1]) == 0x52 &&
               read_first_byte(physical, first_row[2]) == 0x55,
           "compact publication does not move page bytes");
    expect(physical.allocated_pages() == 8,
           "compact publication keeps every logical page's Device replica");

    // Frontier 400 makes page 5 full and page 6 the new partial tail; the logical
    // address and the compact row can both advance.
    addresses.commit_frontier(*address, 400);
    const std::array<std::uint32_t, 4> second{0, 2, 5, 6};
    addresses.publish_compact_view(*address, second, 3 * 64 + 16, device.stream);
    device.synchronize();
    expect(addresses.mapped_pages(*address) == 8,
           "logical mapping continues after a compact publication");
    const auto second_row = read_row(tables, 0, 4);
    expect(second_row[3] == before[6], "the appended compact slot uses the new page");

    const auto reject = [&](auto&& call, const char* message) {
        bool threw = false;
        try {
            call();
        } catch (const std::invalid_argument&) { threw = true; }
        expect(threw, message);
    };
    const std::array<std::uint32_t, 2> unordered{2, 0};
    reject([&] { addresses.publish_compact_view(*address, unordered, 65, device.stream); },
           "unordered compact pages are rejected");
    const std::array<std::uint32_t, 1> outside{99};
    reject([&] { addresses.publish_compact_view(*address, outside, 64, device.stream); },
           "a compact page outside the address is rejected");
    const std::array<std::uint32_t, 2> zero_tail{0, 2};
    reject([&] { addresses.publish_compact_view(*address, zero_tail, 64, device.stream); },
           "a zero-token compact tail is rejected");
}
void test_pending_compact_view(ninfer::DeviceContext& device) {
    ninfer::LayoutBuilder builder;
    const auto layout = ninfer::plan_device_kv_page_pool(builder, {
        .page_group_count = 16, .allow_logical_reservation = true,
        .geometry = {.page_tokens = 64,
            .device_plane_order = ninfer::PagedKVPlaneOrder::PageMajor,
            .planes = {{.dtype = ninfer::DType::BF16, .leading_extent = 8, .head_extent = 2}}}});
    const auto table_layout = ninfer::plan_kv_execution_tables(builder,
        {.logical_page_capacity = 16, .table_rows = 1});
    ninfer::DeviceArena arena(builder.finish(256));
    const ninfer::DeviceSpan backing{arena.base(), arena.capacity()};
    ninfer::DeviceKVPagePool physical(backing, layout);
    ninfer::KVExecutionTablePool tables(backing, table_layout, physical);
    store::LogicalKVPageStore pages(physical, 32);
    store::KVAddressSpaceStore addresses(pages, tables, 2, 16);
    const auto address = addresses.create_active(12, 0, {});
    expect(address.has_value(), "pending suffix fixture address");
    if (!address) { return; }
    addresses.ensure_mapped_to_tokens(*address, 12 * 64, device.stream);
    addresses.commit_frontier(*address, 702); // page 10 has 62 committed columns
    device.synchronize();
    const auto original = read_row(tables, 0, 12);
    const auto selected = store::compact_selection(12, 702, 64, 1, 1, {});
    expect(selected == std::vector<std::uint32_t>({0, 10, 11}),
           "selection retains the partial page before the final tail");
    addresses.publish_compact_view(*address, selected, 130, device.stream, 4);
    device.synchronize();
    const auto row = read_row(tables, 0, 3);
    for (unsigned position = 702; position < 706; ++position) {
        const auto cache = position - (706 - 130);
        expect(row[cache / 64] == original[position / 64],
               "every speculative write names the correct physical page");
    }
    const auto reject = [&](auto&& call, const char* message) {
        bool threw = false;
        try { call(); } catch (const std::invalid_argument&) { threw = true; }
        expect(threw, message);
    };
    const std::array<std::uint32_t, 3> missing{0, 9, 11};
    reject([&] { addresses.publish_compact_view(*address, missing, 130, device.stream, 4); },
           "a missing pending start page is rejected");
    reject([&] { addresses.publish_compact_view(*address, selected, 130, device.stream, 2); },
           "an uncommitted historical middle page is rejected");
    // Switching modes must republish even when ensure_mapped does not grow the address.
    addresses.publish_compact_view(*address, selected, 130, device.stream, 4);
    addresses.ensure_mapped_to_tokens(*address, 706, device.stream);
    addresses.publish_logical_view(*address, device.stream);
    device.synchronize();
    expect(read_row(tables, 0, 12) == original,
           "logical publication restores the whole row without allocation or growth");
}
} // namespace

int main() {
    int count                   = 0;
    const cudaError_t count_err = cudaGetDeviceCount(&count);
    if (count_err == cudaErrorNoDevice || count_err == cudaErrorInsufficientDriver || count == 0) {
        std::printf("SKIP: no usable CUDA device\n");
        return 77;
    }
    CUDA_CHECK(count_err);
    try {
        ninfer::DeviceContext device(0);
        test_compact_view(device);
        test_publish_compact_view(device);
        test_pending_compact_view(device);
        device.synchronize();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FAIL: unexpected exception: %s\n", error.what());
        return 1;
    }
    if (failures == 0) {
        std::printf("PASS: compact execution view keeps selected pages in place, rewrites the "
                    "table row, reclaims sole-owner pages, grows afterwards, and the non-destructive "
                    "publication leaves the logical address and checkpoints intact\n");
    }
    return failures == 0 ? 0 : 1;
}
