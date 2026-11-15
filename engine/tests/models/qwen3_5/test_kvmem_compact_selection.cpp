#include "models/qwen3_5/program/storage/compact_selection.h"

#include <array>
#include <cstdio>
#include <limits>

namespace s = ninfer::models::qwen3_5::detail;

int main() {
    int failed = 0;
    const auto expect = [&](bool ok, const char* message) {
        if (!ok) { ++failed; std::fprintf(stderr, "FAIL: %s\n", message); }
    };
    // Independent coordinate oracle: every target write must land on its logical page.
    // Sweep all page offsets and MTP/ngram widths, including a whole 64-token round.
    for (unsigned offset = 0; offset < 64; ++offset) {
        for (unsigned width = 1; width <= 64; ++width) {
            const unsigned begin = 10 * 64 + offset;
            const unsigned end = begin + width;
            const unsigned total = (end + 63) / 64;
            const auto selected = s::compact_selection(total, begin, 64, 1, 1, {});
            const unsigned visible = (static_cast<unsigned>(selected.size()) - 1) * 64 +
                end - (total - 1) * 64;
            const unsigned removed = end - visible;
            for (unsigned position = begin; position < end; ++position) {
                const unsigned cache = position - removed;
                expect(selected.at(cache / 64) * 64 + cache % 64 == position,
                       "pending writes preserve logical coordinates across pages");
            }
            // Commit none, part, or all of the written prefix; the next view remains correct.
            for (unsigned accepted : {0U, width / 2, width}) {
                const unsigned next = begin + accepted;
                const auto resumed = s::compact_selection((next + 1 + 63) / 64,
                                                           next, 64, 1, 1, {});
                expect(std::binary_search(resumed.begin(), resumed.end(), next / 64),
                       "rollback/partial acceptance preserves the next write page");
            }
        }
    }
    std::array<unsigned, 96> retrieval{};
    for (unsigned i = 0; i < retrieval.size(); ++i) { retrieval[i] = 400 + i; }
    const auto daily = s::compact_selection(2000, 127999, 64, 192, 304, retrieval);
    expect(daily.size() == 192 + 304 + 96, "daily budgets are additive when disjoint");
    for (unsigned p = 1696; p < 2000; ++p) {
        expect(std::binary_search(daily.begin(), daily.end(), p), "all recent pages stay visible");
    }
    expect(s::compact_lane_pages(4096, 192, 304, 96, 2) == 602,
           "full daily selection plus pending and slack requires 602 pages per lane");
    expect(s::compact_lane_pages(4096, 192, 304, 96, 3) == 603,
           "unaligned 128-token prefill retains its three-page pending peak");
    const auto prefill = s::compact_selection(25, 20 * 64, 64, 0, 4, {});
    expect(prefill.size() == 9 && prefill.front() == 16 && prefill.back() == 24,
           "prefill pending pages are additional to the previous recent history");
    s::require_compact_lane_capacity(daily.size(), 1200, 2);
    bool rejected = false;
    try { s::require_compact_lane_capacity(daily.size(), 1199, 2); }
    catch (const std::invalid_argument&) { rejected = true; }
    expect(rejected, "one page short rejects instead of shrinking recent/retrieval");
    expect(s::compact_lane_pages(4096, std::numeric_limits<unsigned>::max(), 304, 96, 2)
               == 4104, "budget addition cannot overflow before the logical cap");
    const std::array<unsigned, 4> overlap{0, 1, 14, 15};
    const auto small = s::compact_selection(16, 1023, 64, 4, 4, overlap);
    expect(small.size() == 8, "overlapping budgets are deduplicated");
    std::vector<unsigned> required{0, 5};
    const std::array<unsigned, 5> resident{0, 1, 2, 3, 4};
    s::fill_compact_resident(required, resident, 4);
    expect(required == std::vector<unsigned>({0, 3, 4, 5}),
           "spare capacity retains newest resident history without dropping pending");
    required = {0, 3};
    const std::array<unsigned, 4> mask{0, 1, 2, 3};
    s::fill_compact_resident(required, mask, 4);
    expect(required == std::vector<unsigned>(mask.begin(), mask.end()),
           "the full resident mask survives when its pages fit");
    std::printf("%s: compact selection coordinates, rollback and full budgets\n",
                failed ? "FAIL" : "PASS");
    return failed ? 1 : 0;
}
