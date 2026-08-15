import { describe, expect, it } from "vitest";
import { assertScheduleIsCompatible, calculateStandings, generateRoundRobin } from "./league-service";

describe("eFootball league schedule", () => {
  it("generates double round-robin fixtures for five teams with two matches per day", () => {
    const fixtures = generateRoundRobin([1, 2, 3, 4, 5]);
    expect(fixtures).toHaveLength(20);
    expect(Math.max(...fixtures.map((fixture) => fixture.matchday))).toBe(10);
    expect(() => assertScheduleIsCompatible([1, 2, 3, 4, 5], fixtures)).not.toThrow();
    for (let matchday = 1; matchday <= 10; matchday += 1) {
      expect(fixtures.filter((fixture) => fixture.matchday === matchday)).toHaveLength(2);
    }
  });

  it("generates fourteen matches per team for eight teams with four matches per day", () => {
    const fixtures = generateRoundRobin([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fixtures).toHaveLength(56);
    expect(Math.max(...fixtures.map((fixture) => fixture.matchday))).toBe(14);
    for (let matchday = 1; matchday <= 14; matchday += 1) {
      expect(fixtures.filter((fixture) => fixture.matchday === matchday)).toHaveLength(4);
    }
  });

  it("resolves equal points using direct head-to-head results", () => {
    const standings = calculateStandings(
      [
        { id: 1, name: "Alpha", shortCode: "ALP" },
        { id: 2, name: "Bravo", shortCode: "BRV" },
      ],
      [{ homeTeamId: 1, awayTeamId: 2, homeScore: 2, awayScore: 1 }],
    );
    expect(standings[0].teamId).toBe(1);
    expect(standings[0].points).toBe(3);
  });
});
