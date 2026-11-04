import { describe, it, expect } from "vitest";
import { chain } from "../src/curbgeom.js";

// A straight curb along x, cut where tiles meet.
const at = (x) => [-71.085 + x * 1e-4, 42.343];
describe("chain", () => {
  it("joins pieces that meet at a tile edge", () => {
    expect(chain([[at(0), at(2)], [at(2), at(5)]])).toEqual([at(0), at(2), at(5)]);
  });
  it("merges pieces that overlap by a tile buffer, in either direction", () => {
    const line = chain([[at(3), at(6)], [at(0), at(1), at(4)].reverse()]);
    expect(line[0]).toEqual(at(0));
    expect(line.at(-1)).toEqual(at(6));
    expect(line.every((p, i) => i === 0 || p[0] > line[i - 1][0])).toBe(true); // no doubling back
  });
  it("drops a piece lying entirely along another", () => {
    expect(chain([[at(1), at(2)], [at(0), at(5)]])).toEqual([at(0), at(5)]);
    expect(chain([[at(0), at(5)], [at(1), at(2)], [at(1), at(2)]])).toEqual([at(0), at(5)]);
  });
  it("keeps a parallel piece on another road apart", () => {
    const parts = [[at(0), at(5)], [[at(0)[0], 42.3431], [at(5)[0], 42.3431]]];
    expect(chain(parts)).toEqual([at(0), at(5)]);
    expect(parts).toHaveLength(1);
  });
});

describe("chain keeps the first piece's direction", () => {
  it("when joining, merging and swallowing pieces", () => {
    const dir = (l) => Math.sign(l.at(-1)[0] - l[0][0]);
    expect(dir(chain([[at(5), at(3)], [at(0), at(4)]]))).toBe(-1);
    expect(dir(chain([[at(2), at(1)], [at(0), at(5)]]))).toBe(-1); // the longer copy, turned to match
    expect(dir(chain([[at(1), at(2)], [at(5), at(0)]]))).toBe(1);
  });
});
