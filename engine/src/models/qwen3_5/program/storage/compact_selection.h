#pragma once

#include <algorithm>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <vector>

namespace ninfer::models::qwen3_5::detail {

// Recent is an independent history budget, not the total size of a compact row.
// The pending write suffix may straddle pages even when its token count is small.
inline std::uint64_t compact_lane_pages(std::uint32_t logical_pages,
                                        std::uint32_t sink_pages,
                                        std::uint32_t recent_pages,
                                        std::uint32_t retrieval_pages,
                                        std::uint32_t pending_pages,
                                        std::uint32_t slack_pages = 8) {
    const std::uint64_t selected = static_cast<std::uint64_t>(sink_pages) +
        std::max(recent_pages, 1U) + retrieval_pages + pending_pages;
    return std::min<std::uint64_t>(logical_pages, selected) + slack_pages;
}

inline void require_compact_lane_capacity(std::uint64_t selected_pages,
                                          std::uint32_t physical_pages,
                                          std::uint32_t lanes,
                                          std::uint32_t slack_pages = 8) {
    if (lanes == 0 || selected_pages + slack_pages > physical_pages / lanes) {
        throw std::invalid_argument(
            "compact KV pool cannot preserve each lane's sink/recent/retrieval and write "
            "suffix; increase --kv-capacity or lower --max-concurrency (budgets were not reduced)");
    }
}

inline std::vector<std::uint32_t> compact_selection(
    std::uint32_t total_pages, std::uint32_t committed_tokens,
    std::uint32_t page_tokens, std::uint32_t sink_pages, std::uint32_t recent_pages,
    std::span<const std::uint32_t> retrieval) {
    if (page_tokens == 0 || total_pages == 0 ||
        static_cast<std::uint64_t>(committed_tokens) >
            static_cast<std::uint64_t>(total_pages) * page_tokens) {
        throw std::invalid_argument("invalid compact selection geometry");
    }
    std::vector<std::uint32_t> selected;
    const auto add_range = [&](std::uint32_t begin, std::uint32_t end) {
        for (auto page = begin; page < end; ++page) { selected.push_back(page); }
    };
    add_range(0, std::min(sink_pages, total_pages));
    const auto recent = std::max(recent_pages, 1U);
    const auto committed_pages = static_cast<std::uint32_t>(
        (static_cast<std::uint64_t>(committed_tokens) + page_tokens - 1U) / page_tokens);
    // Pending columns are additional to recent history, including during chunked prefill.
    add_range(committed_pages > recent ? committed_pages - recent : 0U, total_pages);
    // Keep the old partial tail when the current verification crosses into a new page.
    add_range(committed_tokens / page_tokens, total_pages);
    for (auto page : retrieval) {
        if (page < total_pages) { selected.push_back(page); }
    }
    std::sort(selected.begin(), selected.end());
    selected.erase(std::unique(selected.begin(), selected.end()), selected.end());
    return selected;
}

// Preserve the mask path's useful, already resident history in spare row capacity.
// Inputs are ascending; callers supply only fully committed Device-resident pages.
inline void fill_compact_resident(std::vector<std::uint32_t>& required,
                                  std::span<const std::uint32_t> resident,
                                  std::size_t capacity) {
    if (required.size() > capacity) {
        throw std::invalid_argument("compact resident fill cannot shrink required history");
    }
    std::vector<std::uint32_t> extra;
    const auto room = capacity - required.size();
    for (auto it = resident.rbegin(); it != resident.rend() && extra.size() < room; ++it) {
        if (!std::binary_search(required.begin(), required.end(), *it)) { extra.push_back(*it); }
    }
    required.insert(required.end(), extra.begin(), extra.end());
    std::sort(required.begin(), required.end());
}

} // namespace ninfer::models::qwen3_5::detail
