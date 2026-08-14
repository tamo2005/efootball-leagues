import { describe, expect, it } from "vitest";
import { assertScheduleIsCompatible, calculateStandings, generateRoundRobin } from "./league-service";

describe("eFootball league schedule", () => {
  it("generates one compatible round-robin fixture per pairing", () => {
    const fixtures = generateRoundRobin([1, 2, 3, 4, 5]);
    expect(fixtures).toHaveLength(10);
    expect(() => assertScheduleIsCompatible([1, 2, 3, 4, 5], fixtures)).not.toThrow();
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
