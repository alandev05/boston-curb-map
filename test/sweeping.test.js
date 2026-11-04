import { describe, it, expect } from "vitest";
import { parseCsv, normName, rowPolicy, assignSweeping } from "../scripts/sweeping.js";
import { projector } from "../scripts/snap.js";
import { verdict } from "../src/rules.js";

const P = projector(42.35);
const o = P.fwd([-71.08, 42.35]);
const at = (x, y) => P.inv([o[0] + x, o[1] + y]);

describe("normName", () => {
  it("expands the table's abbreviations to OSM's spelling", () => {
    expect(normName("Mt Vernon St")).toBe("mount vernon street");
    expect(normName("Mount Vernon Street")).toBe("mount vernon street");
    expect(normName("St Botolph St")).toBe("saint botolph street");
    expect(normName("Columbus Ave")).toBe(normName("Columbus Avenue"));
    expect(normName('"Anthony ""Rip"" Valenti Way"')).toBe("anthony rip valenti way");
  });
});

describe("parseCsv + rowPolicy", () => {
  const rows = parseCsv(`main_id,st_name,start_time,end_time,side,from,to,miles,week_1,week_2,week_3,week_4,week_5,sunday,monday,tuesday,wednesday,thursday,friday,saturday,every_day,year_round
7,"Elm St",08:00,12:00,Odd,Oak St,Pine St,0.05,t,f,t,f,f,f,f,t,f,f,f,f,f,f
`);
  it("parses quoted fields", () => expect(rows[0].st_name).toBe("Elm St"));
  it("turns a row into a street-cleaning policy: 1st & 3rd Tue 8–12, April–November", () => {
    const p = rowPolicy(rows[0]);
    expect(p.curb_policy_id).toBe("sweep-7");
    expect(p.rules[0].purposes).toEqual(["street_cleaning"]);
    expect(p.time_spans[0]).toMatchObject({ days_of_week: ["tue"], weeks_of_month: [1, 3], months: [4, 5, 6, 7, 8, 9, 10, 11], time_of_day_start: "08:00", time_of_day_end: "12:00" });
  });
});

describe("assignSweeping", () => {
  // Elm St runs east–west at y=0 between Oak St (x=0) and Pine St (x=80). Odd numbers on the north side.
  const osm = {
    names: [
      { name: "Elm Street", coords: [at(-100, 0), at(200, 0)] },
      { name: "Oak Street", coords: [at(0, -100), at(0, 100)] },
      { name: "Pine Street", coords: [at(80, -100), at(80, 100)] },
    ],
    numbers: [{ num: 11, coord: at(30, 15) }, { num: 13, coord: at(50, 15) }, { num: 12, coord: at(30, -15) }, { num: 14, coord: at(50, -15) }],
  };
  // Snapped curbs (centerline geometry + side): north side drawn west→east is side −1; south side +1.
  const curb = (id, x0, x1, side, pids = []) => ({ type: "Feature", properties: { curb_zone_id: id, curb_policy_ids: pids, _side: side, _rc: "minor" }, geometry: { type: "LineString", coordinates: [at(x0, 0), at(x1, 0)] } });
  const row = { main_id: "1", st_name: "Elm St", side: "Odd", from: "Oak St", to: "Pine St", miles: String(80 / 1609.34), start_time: "08:00", end_time: "12:00", week_1: "t", week_2: "f", week_3: "t", week_4: "f", week_5: "f", tuesday: "t", every_day: "f", year_round: "f" };
  it("attaches the rule to curbs on the named street, within the stretch, on the matching side", () => {
    const feats = [curb("north-in", 20, 60, -1), curb("south-in", 20, 60, 1), curb("north-out", 120, 180, -1)];
    const policies = {};
    const stats = assignSweeping(feats, policies, [row], osm);
    expect(stats.rowsMatched).toBe(1);
    expect(feats[0].properties.curb_policy_ids).toContain("sweep-1");      // odd side, inside Oak–Pine
    expect(feats[1].properties.curb_policy_ids).not.toContain("sweep-1");  // even side
    expect(feats[2].properties.curb_policy_ids).not.toContain("sweep-1");  // past Pine St
    expect(verdict(feats[0].properties, policies, "tue", 9 * 60, { date: new Date("2026-11-03T09:00:00") }).category).toBe("street_cleaning");
  });
  it("reads sides from the City's address list, counting only addresses on the curb's own street", () => {
    // No OSM numbers; City addresses on Elm St say north is odd. A corner building's even number on Oak St sits on the
    // north side too, and must not count.
    const city = { names: osm.names, numbers: [], addresses: [[...at(30, 15), 11, "Elm St"], [...at(50, 15), 13, "Elm St"], [...at(40, 15), 20, "Oak St"], [...at(40, 16), 22, "Oak St"], [...at(30, -15), 12, "Elm St"]] };
    const feats = [curb("north-in", 20, 60, -1), curb("south-in", 20, 60, 1)];
    assignSweeping(feats, {}, [row], city);
    expect(feats[0].properties.curb_policy_ids).toContain("sweep-1");
    expect(feats[1].properties.curb_policy_ids).not.toContain("sweep-1");
  });
  it("'Dead End to Dead End' is the whole street, and the same cross street at both ends is a loop off it", () => {
    const whole = { ...row, main_id: "2", side: "", from: "Dead End", to: "Dead End", miles: String(300 / 1609.34) };
    let feats = [curb("west", -90, -40, -1), curb("east", 120, 180, 1)];
    assignSweeping(feats, {}, [whole], osm);
    expect(feats.every((f) => f.properties.curb_policy_ids.includes("sweep-2"))).toBe(true);
    // Elm St only meets Oak St once; "Oak St to Oak St" runs from that junction to the street's end.
    const loop = { ...row, main_id: "3", side: "", from: "Oak St", to: "Oak St", miles: String(200 / 1609.34) };
    feats = [curb("east-of-oak", 120, 180, 1), curb("west-of-oak", -90, -40, 1)];
    assignSweeping(feats, {}, [loop], osm);
    expect(feats[0].properties.curb_policy_ids).toContain("sweep-3");
    expect(feats[1].properties.curb_policy_ids).not.toContain("sweep-3");
  });
  it("finds a cross street whose line stops just short of the street", () => {
    const short = { names: [osm.names[0], { name: "Oak Street", coords: [at(0, 25), at(0, 100)] }, osm.names[2]], numbers: osm.numbers };
    const feats = [curb("north-in", 20, 60, -1)];
    assignSweeping(feats, {}, [row], short);
    expect(feats[0].properties.curb_policy_ids).toContain("sweep-1");
  });
  it("leaves curbs alone whose curb-feed rules already include street cleaning", () => {
    const policies = { cds: { curb_policy_id: "cds", priority: 3, rules: [{ activity: "no parking" }], time_spans: [{ days_of_week: ["wed"], weeks_of_month: [2, 4], months: [4, 5, 6, 7, 8, 9, 10, 11] }] } };
    const feats = [curb("north-in", 20, 60, -1, ["cds"])];
    assignSweeping(feats, policies, [row], osm);
    expect(feats[0].properties.curb_policy_ids).toEqual(["cds"]);
  });
});
