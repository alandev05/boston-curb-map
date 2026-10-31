// Tiny hand-made sample so the map isn't blank if the city API is unreachable.
// Shapes are approximate Newbury St / Boylston St curb segments in Back Bay.
const line = (coords, props) => ({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: props });

export const DEMO_POLICIES = {
  "demo-meter": { curb_policy_id: "demo-meter", priority: 10, published_date: "2026-01-01",
    rules: [{ activity: "parking", max_stay: 120, user_classes: ["car"], rate: [{ rate: 375, rate_unit: "hour" }] }],
    time_spans: [{ days_of_week: ["mon","tue","wed","thu","fri","sat"], time_of_day_start: "08:00", time_of_day_end: "20:00" }] },
  "demo-rpp": { curb_policy_id: "demo-rpp", priority: 20,
    rules: [{ activity: "parking", user_classes: ["resident permit"] }],
    time_spans: [] },
  "demo-sweep": { curb_policy_id: "demo-sweep", priority: 1,
    rules: [{ activity: "no parking", purposes: ["street cleaning"] }],
    time_spans: [{ days_of_week: ["tue"], time_of_day_start: "08:00", time_of_day_end: "12:00", start_date: "2026-04-01", end_date: "2026-11-30" }] },
  "demo-load": { curb_policy_id: "demo-load", priority: 5,
    rules: [{ activity: "loading", user_classes: ["commercial"] }],
    time_spans: [{ days_of_week: ["mon","tue","wed","thu","fri"], time_of_day_start: "07:00", time_of_day_end: "11:00" }] },
  "demo-nostop": { curb_policy_id: "demo-nostop", priority: 0,
    rules: [{ activity: "no stopping" }], time_spans: [] },
};

export const DEMO_ZONES = {
  type: "FeatureCollection",
  meta: { demo: true },
  features: [
    line([[-71.0838, 42.3519], [-71.0818, 42.3512]], { curb_zone_id: "d1", user_zone_id: "2001", street_name: "Newbury St", street_side: "N", curb_policy_ids: ["demo-sweep", "demo-meter", "demo-rpp"] }),
    line([[-71.0818, 42.3512], [-71.0797, 42.3505]], { curb_zone_id: "d2", user_zone_id: "2002", street_name: "Newbury St", street_side: "N", curb_policy_ids: ["demo-load", "demo-meter"] }),
    line([[-71.0797, 42.3505], [-71.0776, 42.3498]], { curb_zone_id: "d3", user_zone_id: "2003", street_name: "Newbury St", street_side: "N", curb_policy_ids: ["demo-nostop"] }),
    line([[-71.0840, 42.3509], [-71.0800, 42.3495]], { curb_zone_id: "d4", user_zone_id: "2101", street_name: "Boylston St", street_side: "S", curb_policy_ids: ["demo-meter"] }),
    line([[-71.0860, 42.3528], [-71.0845, 42.3523]], { curb_zone_id: "d5", user_zone_id: "2201", street_name: "Commonwealth Ave", street_side: "S", curb_policy_ids: ["demo-rpp"] }),
  ],
};
