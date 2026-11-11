#pragma once
#include <algorithm>
#include <cstdint>
#include <span>
#include <vector>

namespace ninfer::ops {
// Score-order input. Only recent-range members may be replaced; all original cold
// members survive. This is a selection contract, not a claim that the ring hard-pins
// the recent range (the current ring uses oldest-first demotion).
inline std::vector<std::uint32_t> overlap_predecessor_pages(
    std::span<const std::uint32_t> ranked, std::uint32_t begin,
    std::uint32_t end, std::uint32_t recent_pages) {
    std::vector<std::uint32_t> result(ranked.begin(),ranked.end());
    auto sorted=result;std::sort(sorted.begin(),sorted.end());
    const auto finish=[&]() { std::sort(result.begin(),result.end());return result; };
    if (end<=begin || recent_pages==0 || recent_pages>=end-begin ||
        std::adjacent_find(sorted.begin(),sorted.end())!=sorted.end() ||
        std::any_of(ranked.begin(),ranked.end(),[&](auto id){return id<begin || id>=end;}))
        return finish();
    const auto cold_end=end-recent_pages;
    const auto contains=[&](auto id) { return std::binary_search(sorted.begin(),sorted.end(),id); };
    const std::size_t cap=std::min<std::size_t>(8,ranked.size()/8);
    std::vector<std::uint32_t> proposals;
    std::size_t anchors=0;
    for (auto page:ranked) {
        if (page>=cold_end) continue;
        if (page>begin && !contains(page-1) &&
            std::find(proposals.begin(),proposals.end(),page-1)==proposals.end())
            proposals.push_back(page-1);
        if (++anchors==8) break;
    }
    std::size_t inserted=0;
    for (std::size_t i=ranked.size();i>0 && inserted<cap && inserted<proposals.size();--i) {
        if (ranked[i-1]>=cold_end) result[i-1]=proposals[inserted++];
    }
    return finish();
}
}
